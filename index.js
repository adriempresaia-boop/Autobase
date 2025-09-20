// index.js — Autobase (CommonJS)
// Playwright + Express. Requiere: playwright-chromium

require('dotenv').config();
const express = require('express');
const { chromium } = require('playwright');

const CHAT_URL = process.env.CHAT_URL || 'https://chathomebase.com/login';
const EMAIL = process.env.EMAIL || '';
const PASSWORD = process.env.PASSWORD || '';
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || '';
const MIN_CHARS = parseInt(process.env.MIN_CHARS || '180', 10);
const MAX_CHARS = parseInt(process.env.MAX_CHARS || '280', 10);
const LOOP_DELAY_MS = parseInt(process.env.LOOP_DELAY_MS || '7000', 10);
const PORT = process.env.PORT || 8080;

let browser, context, page;
let running = true;
let lastSentHash = '';

/* ---------------- utils ---------------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (a,b) => Math.floor(Math.random()*(b-a+1))+a;

function hash(s){let h=0;for(let i=0;i<s.length;i++){h=((h<<5)-h)+s.charCodeAt(i);h|=0;}return String(h);}

function normSpaces(t){return t.replace(/\s+/g,' ').replace(/\s([?.!,;:])/g,'$1').trim();}
function sentenceCase(t){return t.replace(/\b([A-ZÁÉÍÓÚÑ]{4,})\b/g,m=>m.toLowerCase());}
function ensureSpanish(t){
  const map = { ok:'vale', okay:'vale', sure:'claro', really:'de verdad', sorry:'perdona', yes:'sí', nope:'no', thanks:'gracias' };
  return t.split(/\b/).map(w=>{const k=w.toLowerCase();return map[k]?(/[A-Z]/.test(w[0])?map[k][0].toUpperCase()+map[k].slice(1):map[k]):w;}).join('');
}
function cleanAndClamp(t){
  let out = ensureSpanish(sentenceCase(normSpaces(t)));
  const banned = /porn[oó]|pornografía|follar|chupar|corrida|polla|mamada|sexo explícito/gi;
  out = out.replace(banned, 'eso');
  if (out.length < MIN_CHARS) out += ' Me gusta que la charla fluya con calma y respeto, con buen humor y sin prisas. ';
  if (out.length > MAX_CHARS){
    out = out.slice(0, MAX_CHARS);
    const cut = Math.max(out.lastIndexOf('.'), out.lastIndexOf('!'), out.lastIndexOf('?'));
    if (cut > 60) out = out.slice(0, cut+1);
  }
  if (!/[.!?…]$/.test(out)) out += '.';
  return out;
}

async function waitVisibleAny(p, selectors, timeout = 15000){
  const start = Date.now();
  while(Date.now()-start < timeout){
    for(const sel of selectors){
      const loc = p.locator(sel);
      if (await loc.count()){
        try{ await loc.first().waitFor({state:'visible', timeout:800}); return loc.first(); }catch{}
      }
    }
    await sleep(200);
  }
  throw new Error('Elemento no visible: '+selectors.join(', '));
}

/* ------------- detección / cierre de modales y overlays ------------- */
async function dismissOnboarding(){
  // Cierra wizard “NEXT … CLOSE” si aparece
  for (let i=0;i<12;i++){
    const dialog = page.locator('[role="dialog"][aria-modal="true"], .modal:visible, .v-modal:visible');
    if (await dialog.count()){
      const close = page.locator('button:has-text("CLOSE"), button:has-text("Close"), button:has-text("Cerrar")');
      if (await close.count()){ await close.first().click(); await sleep(250); continue; }
      const next = page.locator('button:has-text("NEXT"), button:has-text("Next"), button:has-text("Siguiente")');
      if (await next.count()){ await next.first().click(); await sleep(250); continue; }
      const ok = page.locator('button:has-text("OK"), button:has-text("Ok"), button:has-text("Entendido")');
      if (await ok.count()){ await ok.first().click(); await sleep(250); continue; }
      await page.keyboard.press('Escape');
      await sleep(200);
    } else break;
  }
  // Si hay cortina bloqueando clics:
  const overlay = page.locator('.modal-backdrop, .overlay, [class*="overlay"][style*="opacity"], [class*="backdrop"]');
  if (await overlay.count()){ try{ await page.keyboard.press('Escape'); }catch{} }
}

// NUEVO: cerrar aviso azul de copy/paste si aparece
async function dismissPasteWarning(){
  const bar = page.locator('text=/Your text won\\\'t be inserted|copiar|pegar|paste/i');
  if (await bar.count()){
    const close = page.locator('button:has-text("CLOSE"), button:has-text("Close"), button:has-text("Cerrar"), button:has-text("OK")');
    if (await close.count()) { await close.first().click().catch(()=>{}); }
    else { await page.keyboard.press('Escape').catch(()=>{}); }
    await sleep(200);
  }
}

// NUEVO: cerrar overlay “You have a chat claimed” tocando la pantalla
async function dismissClaimedOverlay(){
  try{
    const claim = page.locator('[data-testid="claimedNotification"], .claimed-notification, .chat-claimed-notification, text=/You have a chat claimed/i');
    if (await claim.count()){
      // intenta botón de cierre si existe
      const closeBtn = claim.locator('button:has-text("close"), button:has-text("CLOSE"), button:has-text("ok"), button:has-text("OK"), button:has-text("Cerrar")');
      if (await closeBtn.count()){
        await closeBtn.first().click().catch(()=>{});
      } else {
        // clic al centro del overlay; si no hay bbox, al centro de la página
        const bb = await claim.first().boundingBox().catch(()=>null);
        if (bb){
          await page.mouse.click(bb.x + bb.width/2, bb.y + bb.height/2).catch(()=>{});
        }else{
          const v = page.viewportSize() || {width: 1200, height: 800};
          await page.mouse.click(Math.floor(v.width/2), Math.floor(v.height/2)).catch(()=>{});
        }
      }
      await sleep(150);
    }
  }catch{}
}

/* ---------------- leer últimos mensajes (solo centro) ---------------- */
async function getRecentMessages(){
  const js = `
  (() => {
    const qs = (s, r=document) => Array.from(r.querySelectorAll(s));
    const isAside = n => !!n.closest('aside,[role="complementary"],.sidebar,[class*="side"]');
    const containers = qs('main .messages, main .chat, .chat-area, .conversation, [data-testid*="chat"], [class*="chat-body"], [class*="messages"]')
      .filter(c => !isAside(c));
    const root = containers[0] || document.querySelector('main') || document.body;
    const bubbles = qs('[class*="message"],[class*="bubble"],.msg,.message', root)
      .filter(n => !isAside(n));
    const lines = (bubbles.length ? bubbles : [root])
      .map(n => (n.innerText||'').trim())
      .join('\\n')
      .split(/\\n+/)
      .map(x => x.trim())
      .filter(Boolean)
      .filter(l => !/^PROFILE DETAILS|^ADD NEW LOG|^SEXUAL PREFERENCES|^UPDATES|^FAMILY|^PERSONAL INFO|^WORK|^OTHER/i.test(l));
    return lines.slice(-40).join('\\n');
  })();`;
  const raw = await page.evaluate(js);
  const lines = raw.split('\n').filter(Boolean);
  const chunk = lines.slice(-12).join('\n');
  return chunk;
}

/* ------------- generación simple sin LLM ------------- */
function genFallback(replyTo){
  let question = '¿Qué te parece a ti?';
  const lastQ = replyTo.split('?').slice(-2)[0];
  if (replyTo.includes('?') && lastQ) {
    question = `¿${lastQ.trim()}?`;
    question = question.replace(/¿+/g,'¿').replace(/^\u00BF+/, '¿').replace(/\s+/g,' ');
  }
  let base = 'Gracias por contármelo. ';
  if (/trabaj|curro|turno/i.test(replyTo)) base += 'He tenido un día movido, pero me apetecía escribirte un momento. ';
  if (/hoy|mañana|tarde|noche/i.test(replyTo)) base += 'Organizo el día poco a poco y me sienta bien desconectar contigo. ';
  if (/gust|encant|prefer/i.test(replyTo)) base += 'A mí me gusta hablar con naturalidad y respeto, sin prisas. ';
  base += 'Te respondo con sinceridad y sin cruzar líneas. ';
  base += question + ' ';
  return base;
}

async function buildReply(){
  const recent = await getRecentMessages();
  const lastChunk = recent.split('\n').slice(-10).join(' ');
  let out = genFallback(lastChunk);
  return cleanAndClamp(out);
}

/* ------------- tecleo humano (nada de paste/clear) ------------- */
async function typeHuman(textarea, text){
  await textarea.click({ delay: 40 });
  await page.keyboard.type(' ', { delay: rand(10,30) });
  for (const ch of text){
    await page.keyboard.type(ch, { delay: rand(25,70) });
    if (Math.random() < 0.05) await sleep(rand(60,160));
  }
}

/* ---------------- login + navegación ---------------- */
async function loginIfNeeded(){
  try{
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 });
  }catch{}

  if (page.url().includes('/login')){
    const emailBox = await waitVisibleAny(page, ['input[type="email"]','input[name="email"]','input[autocomplete="username"]'], 15000);
    const passBox  = await waitVisibleAny(page, ['input[type="password"]','input[name="password"]','input[autocomplete="current-password"]'], 15000);
    await emailBox.click();
    await emailBox.fill(EMAIL);
    await passBox.click();
    await passBox.fill(PASSWORD);
    const btn = await waitVisibleAny(page, ['button[type="submit"]','button:has-text("Sign in")','button:has-text("SIGN IN")','button:has-text("Entrar")'], 10000);
    await btn.click();
    await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(()=>{});
  }

  // Carrusel/avisos
  await dismissOnboarding();
  // NUEVO: cerrar overlay de “chat claimed”
  await dismissClaimedOverlay();

  // Botón “Start chatting” si aparece
  try{
    const start = page.locator('button:has-text("START CHATTING"), button:has-text("Start chatting"), button:has-text("Start")');
    if (await start.count()) await start.first().click();
  }catch{}
}

/* ---------------- envío ---------------- */
async function typeAndSend(text){
  await dismissOnboarding();
  await dismissPasteWarning();
  // NUEVO: por si aparece justo al cambiar de chat
  await dismissClaimedOverlay();

  const box = await waitVisibleAny(
    page,
    ['textarea','[contenteditable="true"][role="textbox"]','[role="textbox"]'],
    12000
  );

  await typeHuman(box, text);

  const probe = text.slice(0, Math.min(45, text.length)).trim();
  const prevLen = await box.evaluate(el => ((el.value || el.innerText || '').trim().length)).catch(()=>0);

  const wasSent = async () => {
    const len = await box.evaluate(el => ((el.value || el.innerText || '').trim().length)).catch(()=>0);
    if (len === 0 || len < Math.min(4, Math.floor(prevLen*0.3))) return true;
    try{
      const ok = await page.evaluate(s => document.body && document.body.innerText.includes(s), probe);
      if (ok) return true;
    }catch{}
    return false;
  };

  const sendBtn = page.locator([
    'button:has-text("enviar")',
    'button:has-text("ENVIAR")',
    'button:has-text("Enviar")',
    '[role="button"]:has-text("enviar")',
    '[role="button"]:has-text("Enviar")',
    'button[aria-label*="enviar" i]',
    'button[aria-label*="send" i]',
    'button[title*="enviar" i]',
    'button[title*="send" i]',
    '.btn-send'
  ].join(', '));

  if (await sendBtn.count()){
    await sendBtn.first().click({ timeout: 2500 }).catch(()=>{});
    await sleep(500);
    await dismissPasteWarning();
    if (await wasSent()) return true;
  }

  for (const key of ['Enter','Control+Enter','Meta+Enter']){
    await page.keyboard.press(key).catch(()=>{});
    await sleep(600);
    await dismissPasteWarning();
    if (await wasSent()) return true;
  }

  if (await sendBtn.count()){
    await sendBtn.first().click({ timeout: 2500 }).catch(()=>{});
    await sleep(400);
    await page.keyboard.press('Enter').catch(()=>{});
    await sleep(600);
    if (await wasSent()) return true;
  }

  return false;
}

/* ---------------- watchdog / recuperación ---------------- */
async function ensureAlive(){
  if (!browser || !context || !page || page.isClosed()){
    if (browser) await browser.close().catch(()=>{});
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote','--single-process']
    });
    context = await browser.newContext({ viewport:{ width:1366, height:900 } });
    page = await context.newPage();
    await page.goto(CHAT_URL, { timeout: 45000, waitUntil: 'domcontentloaded' });
  }
}

/* ---------------- bucle principal ---------------- */
async function loop(){
  let lastOkAt = Date.now();

  while (running){
    try{
      await ensureAlive();
      await loginIfNeeded();

      await dismissOnboarding();
      await dismissClaimedOverlay();

      const recent = await getRecentMessages();
      const reply = await buildReply();
      const h = hash(recent + '||' + reply);
      if (h === lastSentHash){ await sleep(LOOP_DELAY_MS); continue; }

      const ok = await typeAndSend(reply);
      if (ok){ lastSentHash = h; lastOkAt = Date.now(); }
    }catch(e){
      console.error('Loop error:', e.message);
    }

    if (Date.now() - lastOkAt > 120000){
      try{ await page.reload({ waitUntil:'domcontentloaded', timeout:20000 }); }catch{}
      lastOkAt = Date.now();
    }

    await sleep(LOOP_DELAY_MS);
  }
}

/* ---------------- servidor control ---------------- */
const app = express();
app.use(express.json());
function auth(req,res,next){
  if (!CONTROL_TOKEN) return res.status(403).json({error:'CONTROL_TOKEN not set'});
  const tok = req.query.token || req.headers['x-token'];
  if (tok !== CONTROL_TOKEN) return res.status(401).json({error:'unauthorized'});
  next();
}
app.get('/health', (req,res)=>res.json({running, url: page?.url?.()||null}));
app.post('/pause', auth, (req,res)=>{ running=false; res.json({ok:true,running}); });
app.post('/resume', auth, (req,res)=>{ if(!running){ running=true; loop().catch(()=>{});} res.json({ok:true,running}); });
app.get('/screenshot', auth, async (req,res)=>{
  try{ const buf = await page.screenshot({ fullPage:true }); res.set('Content-Type','image/png'); res.send(buf); }
  catch(e){ res.status(500).json({error:e.message}); }
});
app.get('/html', auth, async (req,res)=>{ try{ res.send(await page.content()); }catch(e){ res.status(500).json({error:e.message}); }});

/* ---------------- arranque ---------------- */
(async ()=>{
  await ensureAlive();
  app.listen(PORT, ()=>console.log('Server listening on', PORT));
  loop().catch(err=>console.error('Main loop crash', err));
})().catch(err=>{ console.error('Fatal launch error', err); process.exit(1); });
