// index.js (ESM) – envío robusto
import express from "express";
import { chromium } from "playwright";

const URL = process.env.CHB_URL;
const EMAIL = process.env.LOGIN_EMAIL;
const PASS = process.env.LOGIN_PASSWORD;
const TOKEN = process.env.CONTROL_TOKEN || "changeme";
const MIN_CHARS = Number(process.env.MIN_CHARS || 170);
const MAX_CHARS = Number(process.env.MAX_CHARS || 240);

if (!URL || !EMAIL || !PASS) {
  console.error("[BOOT] Falta CHB_URL / LOGIN_EMAIL / LOGIN_PASSWORD");
  process.exit(1);
}

let browser, context, page;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

async function typeHuman(target, text) {
  await target.focus();
  for (const ch of text) {
    await page.keyboard.type(ch);
    await sleep(15 + Math.floor(Math.random() * 35));
  }
}
async function waitVisibleAny(selectors, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if (await loc.count()) {
        try { await loc.waitFor({ state: "visible", timeout: 600 }); return loc; } catch {}
      }
    }
    await sleep(120);
  }
  return null;
}
async function ensureAlive() {
  try { await page.title(); return true; } catch { return false; }
}

// --- Login
async function loginIfNeeded() {
  const loginLike = page.url().includes("/login") ||
    (await page.locator('input[type="email"], input[name="email"]').count());
  if (!loginLike) return;

  const emailInput = (await waitVisibleAny(['input[type="email"]','input[name="email"]','input[placeholder*="Email" i]'])) ;
  const passInput  = (await waitVisibleAny(['input[type="password"]','input[name="password"]','input[placeholder*="Password" i]'])) ;
  if (!emailInput || !passInput) throw new Error("No encuentro campos de login");

  await emailInput.fill("");
  await typeHuman(emailInput, EMAIL);
  await passInput.fill("");
  await typeHuman(passInput, PASS);

  const signIn = (await waitVisibleAny([
    'button[type="submit"]','button:has-text("SIGN IN")','button:has-text("Iniciar")','button:has-text("Entrar")'
  ])) || page.locator("button").first();

  await signIn.click({ delay: 40 }).catch(()=>{});
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 });
}

// --- Onboarding (NEXT/CLOSE)
async function dismissOnboarding() {
  for (let i = 0; i < 8; i++) {
    const modal = await waitVisibleAny(['.modal:visible','[role="dialog"]:visible'], 500);
    if (!modal) break;
    const next = await waitVisibleAny([
      'button:has-text("NEXT")','button:has-text("Next")','button:has-text("Siguiente")','button:has-text("SIGUIENTE")'
    ], 300);
    const close = await waitVisibleAny([
      'button:has-text("CLOSE")','button:has-text("Close")','button:has-text("CERRAR")','button:has-text("Cerrar")','button:has-text("OK")','button:has-text("Entendido")'
    ], 300);
    if (next) { await next.click({delay:30}).catch(()=>{}); await sleep(180); continue; }
    if (close){ await close.click({delay:30}).catch(()=>{}); await page.keyboard.press("Escape").catch(()=>{}); await sleep(220); break; }
  }
  await page.keyboard.press("Escape").catch(()=>{});
}

// --- Avisos
async function dismissCopyPasteWarning() {
  const bar = await waitVisibleAny(['text=/Your text won\\\'t be inserted/i','text=/copiar|pegar|paste/i'], 400);
  if (bar) {
    const c = await waitVisibleAny(['button:has-text("CLOSE")','button:has-text("CERRAR")','button:has-text("OK")'], 400);
    if (c) await c.click().catch(()=>{}); else await page.keyboard.press("Escape").catch(()=>{});
    await sleep(200);
  }
}
async function killBlockingToasts() {
  await page.keyboard.press("Escape").catch(()=>{});
  const btns = page.locator('button:has-text("OK"), button:has-text("Close"), button:has-text("Cerrar")');
  const n = await btns.count();
  for (let i=0;i<n;i++) { await btns.nth(i).click().catch(()=>{}); }
}

// --- Chat helpers
async function composer() {
  return (await waitVisibleAny([
    'textarea:visible',
    '[contenteditable="true"][role="textbox"]:visible',
    '[contenteditable="true"]:visible',
    'div[role="textbox"]:visible',
    'textarea[placeholder*="reply" i]:visible',
    'textarea[placeholder*="escribe" i]:visible',
  ], 2500));
}
async function findSendNear(box) {
  // Buscar el botón dentro del mismo contenedor del composer
  const parent = box.locator('xpath=ancestor-or-self::*[self::div or self::form][.//textarea or .//*[@contenteditable="true"]][1]');
  const candidate = parent.locator([
    'button:has-text("Enviar")',
    'button:has-text("ENVIAR")',
    'button:has-text("Send")',
    'button[title*="enviar" i]',
    '[role="button"][aria-label*="send" i]',
    'button:has(svg)'
  ].join(",")).first();
  if (await candidate.count()) return candidate;
  // fallback global
  return await waitVisibleAny([
    'button:has-text("Enviar")','button:has-text("Send")','[role="button"][aria-label*="send" i]'
  ], 1200);
}
async function countBubbles() {
  return await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll("div,p")).filter(n=>{
      const t=(n.innerText||"").trim();
      return t && t.length>2 && /message|bubble|chat|msg/i.test(n.className||"");
    });
    return nodes.length || Array.from(document.querySelectorAll("p")).length;
  });
}
async function getRecentMessages() {
  const texts = await page.evaluate(()=>{
    const arr=[];
    const push=t=>{ if(!t) return; const s=t.replace(/\s+/g," ").trim(); if(s && s.length>15 && s.length<1200) arr.push(s); };
    const nodes=[...document.querySelectorAll('[class*="chat"], #chat, main, body')];
    for(const r of nodes){
      const items=r.querySelectorAll('div,p,li,section');
      for(const n of items){
        const s=(n.innerText||"").trim();
        if(!s) continue;
        if(/message|bubble|msg|chat/i.test(n.className||"") || s.split(" ").length>6) push(s);
      }
    }
    return arr.slice(-6);
  });
  return texts;
}

// --- Generación en castellano
function buildSpanishReply(history) {
  const last = history.at(-1) || "";
  const base = /hola|buenas|qué tal|como estas/i.test(last)
    ? "hola, gracias por tu mensaje. "
    : /\?/u.test(last) ? "me ha gustado lo que preguntas. " : "te leo y me quedo con varios detalles. ";
  const ack =
    /trabaj|curro|turno/i.test(last) ? "vaya día, espero que el trabajo te haya dejado un rato para desconectar. " :
    /salir|cena|comer|tomar/i.test(last) ? "lo de quedar para picar algo suena bien; me gusta algo tranquilo. " :
    /familia|hija|hijo|niet|madre|padre/i.test(last) ? "se nota que valoras mucho a tu familia, y eso me gusta. " :
    /deporte|gimnas|andar|paseo/i.test(last) ? "qué bien que te cuides; yo también intento moverme a diario. " :
    "me quedo con lo que cuentas y cómo lo cuentas. ";
  const self = "yo busco una conversación natural, con humor y complicidad, sin prisas y con respeto a los límites. ";
  const ask =
    /\?/u.test(last) ? "¿qué te apetecería que pasara en nuestra próxima charla para dejarte buen sabor?" :
    /salir|cena|tomar/i.test(last) ? "¿prefieres un plan tranquilo de charla o algo más movido para reírnos?" :
    /trabaj|curro|turno/i.test(last) ? "¿cómo sueles desconectar cuando terminas el día?" :
    /deporte|gimnas|andar|paseo/i.test(last) ? "¿cuál es tu forma favorita de activarte sin complicarte?" :
    "¿sobre qué te gustaría que sigamos hablando ahora?";
  let msg = (base + ack + self + ask).replace(/\s+/g, " ").trim();
  if (msg.length < MIN_CHARS) {
    const pad = " por mi parte intento ser cercana y clara, sin copiar ni pegar textos, y siempre con educación. si te apetece seguimos el hilo y buscamos un punto en común. ";
    while (msg.length < MIN_CHARS) msg += pad.slice(0, MIN_CHARS - msg.length);
  }
  if (msg.length > MAX_CHARS) msg = msg.slice(0, MAX_CHARS - 1) + "…";
  msg = msg.replace(/[A-Z]{3,}/g, (m) => m[0] + m.slice(1).toLowerCase()).replace(/\s([?.!,;:])/g, "$1");
  return msg;
}

// --- Escribir y ENVIAR (robusto)
async function typeAndSendMessage() {
  const box = await composer();
  if (!box) throw new Error("No encuentro el cuadro de texto");
  const history = await getRecentMessages();
  const text = buildSpanishReply(history);
  console.log(`[${now()}] GEN fallback len=${text.length}`);

  await box.click();
  // añadir (sin borrar)
  await typeHuman(box, (await box.evaluate(el => (el.value || el.innerText || "").trim().length? " ":"")) + text);

  // cerrar aviso copy-paste si aparece
  await dismissCopyPasteWarning();

  // verificación previa
  const beforeCount = await countBubbles();

  // 1) Click al botón de enviar (cercano al composer)
  let sent = false;
  const btn = await findSendNear(box);
  if (btn) { await btn.click({ delay: 40 }).catch(()=>{}); await sleep(450); }

  // 2) Si no vemos cambio, atajos
  for (const key of ["Control+Enter", "Enter"]) {
    if (sent) break;
    const ok = await page.keyboard.press(key).then(()=>true).catch(()=>false);
    if (ok) await sleep(450);
    const afterCount = await countBubbles();
    sent = afterCount > beforeCount;
  }

  // 3) último intento: repetir click y blur/focus para activar
  if (!sent) {
    try { await box.blur(); } catch {}
    const btn2 = await findSendNear(box);
    if (btn2) { await btn2.click({delay:40}).catch(()=>{}); await sleep(600); }
    const afterCount2 = await countBubbles();
    sent = afterCount2 > beforeCount;
  }

  // 4) si sigue sin enviar, cerrar barra azul y un Enter final
  if (!sent) {
    await dismissCopyPasteWarning();
    await page.keyboard.press("Enter").catch(()=>{});
    await sleep(500);
    const afterCount3 = await countBubbles();
    sent = afterCount3 > beforeCount;
  }

  console.log(`[${now()}] SEND ${sent ? "processed" : "maybe"}`);
  return sent;
}

// --- Boot & loop
async function boot() {
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-gpu","--single-process","--no-zygote"]
  });
  context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on("dialog", async (d)=>{ try{await d.dismiss();}catch{} });
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  console.log(`[${now()}] GOTO ${URL}`);
}

async function loop() {
  try {
    if (!(await ensureAlive())) { await safeClose(); await boot(); }
    await loginIfNeeded();
    await dismissOnboarding();
    await killBlockingToasts();
    await dismissCopyPasteWarning();

    const startBtn = await waitVisibleAny([
      'button:has-text("START CHATTING")','button:has-text("Start")','button:has-text("Comenzar")'
    ], 400);
    if (startBtn) await startBtn.click().catch(()=>{});

    const ok = await typeAndSendMessage().catch(e=>{
      console.log(`[${now()}] WARN send: ${e.message}`); return false;
    });

    await sleep(ok ? 7000 : 12000);
  } catch (e) {
    console.log(`[${now()}] Loop error: ${e.message}`);
    await sleep(6000);
  }
}

async function safeClose(){ try{await page?.close();}catch{} try{await context?.close();}catch{} try{await browser?.close();}catch{} page=context=browser=null; }

// --- Mini API
const app = express();
app.get("/health", (req, res) => {
  if (req.query.token !== TOKEN) return res.status(403).json({ ok:false });
  res.json({ ok:true, ts: now() });
});
app.get("/screenshot", async (req, res) => {
  try { const buf = await page.screenshot({ fullPage: true }); res.set("Content-Type","image/png").send(buf); }
  catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});
app.listen(process.env.PORT || 8080, ()=> console.log(`[${now()}] Server listening on ${process.env.PORT || 8080}`));

// Start
boot().then(async ()=>{ while(true) await loop(); }).catch(async e=>{ console.error("BOOT fail:", e); await safeClose(); process.exit(1); });
