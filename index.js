// index.js
// Autobase – Playwright + Express (CommonJS)

require('dotenv').config();
const express = require('express');
const { chromium } = require('playwright');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

/*** CONFIG ***/
const CHAT_URL = process.env.CHAT_URL || 'https://chathomebase.com/login';
const EMAIL = process.env.EMAIL || '';
const PASSWORD = process.env.PASSWORD || '';
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || '';
const MIN_CHARS = parseInt(process.env.MIN_CHARS || '180', 10);
const MAX_CHARS = parseInt(process.env.MAX_CHARS || '280', 10);
const LOOP_DELAY_MS = parseInt(process.env.LOOP_DELAY_MS || '8000', 10);
const PORT = process.env.PORT || 8080;

// LLM opcional
const LLM_URL = process.env.LLM_URL || '';
const LLM_KEY = process.env.LLM_KEY || '';

/*** ESTADO ***/
let browser, context, page;
let running = true;
let lastSentHash = '';

/*** UTILIDADES ***/
const sleep = ms => new Promise(r => setTimeout(r, ms));

function normSpaces(t) {
  return t.replace(/\s+/g, ' ').replace(/\s([?.!,;:])/g, '$1').trim();
}
function sentenceCase(t) {
  // Evita palabras todo MAYÚSCULAS salvo siglas de 2-3 letras
  return t.replace(/\b([A-ZÁÉÍÓÚÑ]{4,})\b/g, (m) => m.toLowerCase());
}
function ensureSpanish(t) {
  // Pequeño filtro de palabras en inglés comunes que a veces cuelan
  const map = {
    'ok': 'vale',
    'okay': 'vale',
    'sure': 'claro',
    'really': 'de verdad',
    'sorry': 'perdona',
    'yes': 'sí',
    'nope': 'no',
    'thanks': 'gracias'
  };
  return t.split(/\b/).map(w => {
    const k = w.toLowerCase();
    return map[k] ? (/[A-Z]/.test(w[0]) ? map[k][0].toUpperCase()+map[k].slice(1) : map[k]) : w;
  }).join('');
}
function cleanAndClamp(t) {
  let out = ensureSpanish(sentenceCase(normSpaces(t)));
  // Censura básica de vocabulario explícito (ajústalo si hace falta)
  const banned = /porno|pornografía|follar|chupar|corrida|polla|mamada|sexo explícito/gi;
  out = out.replace(banned, 'eso');
  // Longitud
  if (out.length < MIN_CHARS) {
    out += ' Me gusta que la charla fluya con calma y respeto, sin prisas y con naturalidad. Prefiero ir conociéndonos poco a poco y que la conversación siga su curso. ';
  }
  if (out.length > MAX_CHARS) {
    out = out.slice(0, MAX_CHARS);
    // corta por frase
    const cut = Math.max(out.lastIndexOf('.'), out.lastIndexOf('!'), out.lastIndexOf('?'));
    if (cut > 50) out = out.slice(0, cut + 1);
  }
  // Remate final
  if (!/[.!?…]$/.test(out)) out += '.';
  return out;
}
function hash(s) {
  let h = 0; for (let i=0;i<s.length;i++) { h=((h<<5)-h)+s.charCodeAt(i); h|=0; }
  return String(h);
}

async function waitVisibleAny(p, selectors, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const sel of selectors) {
      const el = p.locator(sel);
      if (await el.count()) {
        try {
          await el.first().waitFor({ state: 'visible', timeout: 1000 });
          return el.first();
        } catch {}
      }
    }
    await sleep(250);
  }
  throw new Error('Elemento no visible: '+selectors.join(', '));
}

/*** LECTURA DE ÚLTIMOS MENSAJES ***/
async function getRecentMessages() {
  // Intenta coger solo burbujas de chat; si no, cae a body
  const js = `
  (() => {
    const q = sel => Array.from(document.querySelectorAll(sel));
    // Intenta distintas clases comunes del sitio
    const candidates = [
      '.message', '.chat-message', '.bubble', '.msg', '.talk', '[class*="message"]'
    ].flatMap(s => q(s));
    const nodes = candidates.length ? candidates : [document.body];
    const texts = nodes.map(n => (n.innerText || '').trim()).filter(Boolean);
    // Nos quedamos con el bloque grande del centro si hay muchos
    let joined = texts.join('\\n').replace(/\\n\\n+/g,'\\n');
    // Recorta a lo último
    if (joined.length > 4000) joined = joined.slice(-4000);
    const lines = joined.split('\\n').map(x => x.trim()).filter(Boolean);
    // elimina contenidos laterales obvios
    const filtered = lines.filter(l =>
      !/^PROFILE DETAILS|^ADD NEW LOG|^SEXUAL PREFERENCES|^UPDATES|^FAMILY|^PERSONAL INFO/i.test(l)
    );
    return filtered.slice(-30).join('\\n');
  })();
  `;
  const raw = await page.evaluate(js);
  // Partimos en mensajes y cogemos 4-6 últimos
  let lines = raw.split('\n').filter(Boolean);
  // Intenta detectar bloques por “—” o tiempo; si no, usa líneas simples
  const recent = lines.slice(-20).join('\n');
  return recent;
}

/*** GENERACIÓN ***/
async function genWithLLM(prompt) {
  if (!LLM_URL) return '';
  const body = { input: prompt, max_tokens: 2200, temperature: 0.6 };
  const headers = { 'Content-Type': 'application/json' };
  if (LLM_KEY) headers['Authorization'] = `Bearer ${LLM_KEY}`;
  try {
    const r = await fetch(LLM_URL, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('LLM HTTP '+r.status);
    const data = await r.json();
    // admite formatos {output:"..."} o {choices:[{text:"..."}]}
    const out = data.output || (data.choices && data.choices[0] && (data.choices[0].text || data.choices[0].message?.content)) || '';
    return (out || '').trim();
  } catch (e) {
    console.error('LLM error', e.message);
    return '';
  }
}

function genFallback(replyTo) {
  // Reglas simples: responde y pregunta sobre lo mismo
  let question = '¿Y tú cómo lo ves?';
  if (/\?/.test(replyTo)) {
    const qMatch = replyTo.split('?').slice(-2)[0]; // última pregunta
    question = `¿${qMatch.trim()}?`;
    // limpia
    question = question.replace(/¿+/g,'¿').replace(/\s+/g,' ').replace(/^[¿? ]+/,'¿');
  }
  let base = 'Gracias por contármelo. Me lo he leído con calma y me gusta que lo hablemos con naturalidad. ';
  if (/trabaj|curro/i.test(replyTo)) base += 'Mi día está siendo intenso, pero estoy sacando un rato para escribirte tranquilo. ';
  if (/hoy|mañana|tarde|noche/i.test(replyTo)) base += 'Organizo el día poco a poco y me sienta bien desconectar un momento contigo. ';
  if (/gust|prefer|encant/i.test(replyTo)) base += 'A mí me gusta que la conversación fluya, sin prisas y con buen rollo. ';
  base += 'Te respondo con sinceridad y con respeto, sin cruzar líneas. ';
  base += question + ' ';
  return base;
}

async function buildReply() {
  const recent = await getRecentMessages();
  const lastChunk = recent.split('\n').slice(-10).join(' ');
  const prompt =
`Escribe una única respuesta en ESPAÑOL NEUTRO para continuar el chat. Reglas:
- Responde a lo que te preguntan en los últimos mensajes (solo usa ese contexto).
- Tono cercano y educado; nada explícito; no propongas quedar ni des datos personales.
- Entre ${MIN_CHARS} y ${MAX_CHARS} caracteres aprox.
- Evita mayúsculas salvo al inicio de frases o nombres.
- Cierra SIEMPRE con una pregunta abierta relacionada con el tema.
- No copies texto literal del usuario; redáctalo con tus palabras.

Últimos mensajes (del más antiguo al más reciente):
${lastChunk}

Ahora tu respuesta:`;

  let out = '';
  if (LLM_URL) out = await genWithLLM(prompt);
  if (!out) out = genFallback(lastChunk);
  return cleanAndClamp(out);
}

/*** LOGIN + NAVEGACIÓN ***/
async function loginIfNeeded() {
  try {
    await page.waitForLoadState('domcontentloaded');
    if (page.url().includes('/login')) {
      const emailBox = await waitVisibleAny(page, ['input[type="email"]','input[name="email"]','input[autocomplete="username"]']);
      const passBox  = await waitVisibleAny(page, ['input[type="password"]','input[name="password"]','input[autocomplete="current-password"]']);
      await emailBox.click();
      await emailBox.fill('');
      await page.keyboard.type(EMAIL, { delay: 30 });
      await passBox.click();
      await passBox.fill('');
      await page.keyboard.type(PASSWORD, { delay: 30 });
      // botón
      const btn = await waitVisibleAny(page, ['button[type="submit"]','button:has-text("Sign in")','button:has-text("SIGN IN")','button:has-text("Entrar")'], 10000);
      await btn.click();
      await page.waitForLoadState('networkidle', { timeout: 20000 });
    }
  } catch (e) {
    console.error('loginIfNeeded', e.message);
  }
  // Cierra el carrusel de avisos (pulsar NEXT hasta CLOSE)
  try {
    for (let i=0;i<10;i++) {
      const next = page.locator('button:has-text("NEXT"), button:has-text("Next"), button:has-text("Siguiente")');
      const close = page.locator('button:has-text("CLOSE"), button:has-text("Close"), button:has-text("Cerrar")');
      if (await close.count()) { await close.click(); break; }
      if (await next.count()) { await next.click(); await sleep(300); continue; }
      break;
    }
  } catch {}
  // Start chatting si aparece
  try {
    const start = page.locator('button:has-text("START CHATTING"), button:has-text("Start chatting"), button:has-text("Start")');
    if (await start.count()) await start.click();
  } catch {}
}

/*** ENVÍO ***/
async function typeAndSend(text) {
  // Localiza el cuadro de texto (sin borrar)
  const box = await waitVisibleAny(page, ['textarea','[contenteditable="true"][role="textbox"]','[role="textbox"]'], 12000);
  await box.click({ delay: 50 });
  // escribir SIEMPRE con teclado (no paste)
  await page.keyboard.type(' '); // “despertar” detecciones
  await page.keyboard.type(text, { delay: 15 });

  // Enviar: intenta con botón; si no, Enter
  let sent = false;
  try {
    const sendBtn = page.locator('button:has-text("send"), button:has-text("enviar"), button[title*="Send"], button[aria-label*="Send"], .btn-send');
    if (await sendBtn.count()) {
      await sendBtn.first().click({ timeout: 3000 });
      sent = true;
    }
  } catch {}
  if (!sent) {
    await page.keyboard.press('Enter');
    sent = true;
  }

  // Verifica que apareció en el timeline
  const snippet = text.slice(0, Math.min(30, text.length)).trim();
  try {
    await page.waitForFunction(
      s => document.body && document.body.innerText.includes(s),
      snippet,
      { timeout: 8000 }
    );
    return true;
  } catch {
    return false;
  }
}

/*** BUCLE PRINCIPAL ***/
async function loop() {
  while (running) {
    try {
      await loginIfNeeded();
      // abre chat si hay botón claim/accept
      try {
        const accept = page.locator('button:has-text("CLAIM"), button:has-text("ACCEPT"), button:has-text("Start chatting")');
        if (await accept.count()) await accept.first().click();
      } catch {}

      // si hay bandera “Your message is too short”, lo ignoramos y seguimos
      // leemos últimos mensajes
      const recent = await getRecentMessages();
      const reply = await buildReply();
      const h = hash(recent + '||' + reply);

      if (h === lastSentHash) {
        // Evita reenvío del mismo texto
        await sleep(LOOP_DELAY_MS);
        continue;
      }

      // escribe y envía (sin borrar)
      const ok = await typeAndSend(reply);
      if (ok) lastSentHash = h;

    } catch (e) {
      console.error('Loop error:', e.message);
    }
    await sleep(LOOP_DELAY_MS);
  }
}

/*** SERVIDOR CONTROL ***/
const app = express();
app.use(express.json());

function auth(req, res, next) {
  if (!CONTROL_TOKEN) return res.status(403).json({ error: 'CONTROL_TOKEN not set' });
  if ((req.query.token || req.headers['x-token']) !== CONTROL_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.get('/health', (req,res)=>res.json({ running, url: page?.url?.() || null }));
app.post('/pause', auth, (req,res)=>{ running=false; res.json({ ok:true, running }); });
app.post('/resume', auth, async (req,res)=>{ if (!running){ running=true; loop().catch(()=>{});} res.json({ ok:true, running }); });
app.get('/screenshot', auth, async (req,res)=>{
  try {
    const buf = await page.screenshot({ fullPage: true });
    res.set('Content-Type','image/png'); res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/html', auth, async (req,res)=>{
  try { res.send(await page.content()); } catch (e) { res.status(500).json({ error: e.message }); }
});

(async () => {
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
      '--disable-gpu','--no-zygote','--single-process'
    ]
  });
  context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  page = await context.newPage();
  await page.goto(CHAT_URL, { timeout: 45000, waitUntil: 'domcontentloaded' });

  app.listen(PORT, () => console.log('Server listening on', PORT));
  loop().catch(err => console.error('Main loop crash', err));
})().catch(err => {
  console.error('Fatal launch error', err);
  process.exit(1);
});
