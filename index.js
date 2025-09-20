require("dotenv").config();
const express = require("express");
const { chromium } = require("playwright");

const fetchFn = globalThis.fetch
  ? (...a) => globalThis.fetch(...a)
  : (...a) => import("node-fetch").then(({ default: f }) => f(...a));

const {
  EMAIL,
  PASSWORD,
  OPENAI_API_KEY,
  BASE_URL = "https://chathomebase.com/login",
  MODEL = "gpt-4o-mini",
  CONTROL_TOKEN = "change_me",
  MIN_CHARS: MIN_CHARS_ENV
} = process.env;

const MIN_CHARS = Number(MIN_CHARS_ENV || 190);

const app = express();
app.use(express.json());

let running = true;
let browser, context, page;

const BANNED = [
  "celular","vos ","qué rico","recién","ahorita","computadora",
  "cachetadas","jalar","platicar","carro","papi","lechita","coger "
];

/* ============== UI helpers ============== */
async function clickIfVisible(locator) {
  try {
    const el = locator.first();
    if (await el.isVisible({ timeout: 400 })) { await el.click({ timeout: 1500 }); return true; }
  } catch {}
  return false;
}
async function acceptCookiesAnywhere(p) {
  const texts = [/accept all/i,/accept/i,/agree/i,/allow all/i,/aceptar todas/i,/aceptar/i,/entendido/i];
  for (const t of texts) {
    try {
      const b = p.getByRole("button",{ name: t });
      if (await b.count()) {
        if (await b.first().isVisible({ timeout: 300 })) { await b.first().click({ timeout: 1500 }); await p.waitForTimeout(200); }
      }
    } catch {}
  }
}
async function nukeOverlays(p) {
  try {
    await p.evaluate(() => {
      // elementos concretos y overlays grandes (fixed/absolute con z alto)
      const killList = [
        "[data-testid='claimedNotification']",
        ".chat-claimed-notification",".toast",".Toastify",
        "[role='dialog'][aria-modal='true']",
        ".front-title.d-flex.flex-column.align-center.justify-center"
      ];
      killList.forEach(sel => document.querySelectorAll(sel).forEach(el => { try{ el.style.display="none"; el.remove?.(); }catch{} }));

      const BIG = Array.from(document.querySelectorAll("body *")).filter(el => {
        const s = getComputedStyle(el);
        const pos = s.position;
        const zi  = parseInt(s.zIndex || "0", 10);
        const big = el.clientWidth > 200 && el.clientHeight > 50;
        return (pos === "fixed" || pos === "absolute" || pos === "sticky") && zi > 50 && big;
      });
      BIG.forEach(el => { try{ el.style.pointerEvents="none"; el.style.display="none"; }catch{} });
    });
  } catch {}
}
async function dismissOnboardingWizard(p) {
  for (let i=0;i<12;i++){
    await acceptCookiesAnywhere(p);
    await clickIfVisible(p.getByRole("button",{ name:/close|cerrar|entendido|hecho|ok/i }));
    const next = p.getByRole("button",{ name:/next|siguiente/i });
    if (await next.count()) { await clickIfVisible(next); await p.waitForTimeout(150); continue; }
    const visible = await p.getByText(/información importante sobre expresiones/i).first().isVisible().catch(()=>false);
    if (!visible) break;
    await p.waitForTimeout(120);
  }
}

/* ============== Browser/session ============== */
async function ensureBrowser() {
  if (browser && !browser.isConnected?.()) { try{ await browser.close(); }catch{} browser=null; }
  if (!browser) browser = await chromium.launch({
    headless:true, args:["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"]
  });
  if (!context) context = await browser.newContext({
    viewport:{ width:1366, height:900 },
    locale:"es-ES", timezoneId:"Europe/Madrid",
    userAgent:"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
  });
  if (!page || page.isClosed()) page = await context.newPage();
}

/* ============== Login específico ============== */
const emailSel = 'input[type="email"], input[placeholder="Email"], input[placeholder*="email" i], input[name="email"]';
const passSel  = 'input[type="password"], input[placeholder="Password"], input[placeholder*="password" i], input[name*="pass" i]';
const signSel  = 'button:has-text("SIGN IN"), button:has-text("Sign in"), button:has-text("Login"), button:has-text("Entrar"), button[type="submit"]';

async function isLoginForm() {
  try { return (await page.locator(emailSel).count()) && (await page.locator(passSel).count()); } catch { return false; }
}
async function waitUntilEnabled(locator, timeout=6000) {
  const t0 = Date.now();
  while (Date.now()-t0 < timeout) {
    try { if (!(await locator.isDisabled())) return true; } catch {}
    await page.waitForTimeout(120);
  }
  return false;
}
async function performLogin() {
  const e = page.locator(emailSel).first();
  const p = page.locator(passSel).first();
  try { await e.waitFor({ state:"visible", timeout:5000 }); await p.waitFor({ state:"visible", timeout:5000 }); } catch {}
  try { await e.click({ timeout:2000 }); await e.fill(""); await e.type(EMAIL, { delay:20 }); } catch {}
  try { await p.click({ timeout:2000 }); await p.fill(""); await p.type(PASSWORD, { delay:20 }); } catch {}
  let btn = page.locator(signSel).first();
  await waitUntilEnabled(btn, 5000);
  try { await btn.click({ timeout:2000 }); } catch { try { await p.press("Enter"); } catch {} }
  await page.waitForTimeout(800);
}

/* ============== Cola / claim ============== */
async function isQueueVisible() {
  // chequeo “visual”
  const a = await page.getByText(/Waiting for conversation to be claimed/i).first().isVisible().catch(()=>false);
  const b = await page.getByRole("button",{ name:/start chatting|start chat|start/i }).first().isVisible().catch(()=>false);
  // chequeo “duro” por texto en body
  const c = await page.evaluate(() => {
    const t = (document.body && document.body.innerText) || "";
    return /START CHATTING/i.test(t) || /Waiting for conversation to be claimed/i.test(t);
  }).catch(()=>false);
  return a || b || c;
}

async function tryStartChatting() {
  await nukeOverlays(page);

  const candidates = [
    page.getByRole("button",{ name:/start chatting|start chat|start/i }),
    page.getByText(/^START CHATTING$/i),
    page.locator("[data-testid='start-chatting'], [data-test='start-chatting']")
  ];

  for (const loc of candidates) {
    try {
      const el = loc.first();
      if (!(await el.count())) continue;
      await el.scrollIntoViewIfNeeded().catch(()=>{});
      // 1) click normal
      try { await el.click({ timeout: 800 }); return true; } catch {}
      // 2) click con force (ignora actionability)
      try { await el.click({ timeout: 800, force: true }); return true; } catch {}
      // 3) click desde el DOM
      try { const h = await el.elementHandle(); await page.evaluate(node => node && node.click(), h); return true; } catch {}
      // 4) focus + Enter
      try { await el.focus(); await page.keyboard.press("Enter"); return true; } catch {}
    } catch {}
  }
  return false;
}

/* ============== Chat ============== */
const SELECTORS = {
  chatArea: "main, div[role='main'], div[data-testid='chat']",
  inputCandidates: [
    "textarea","div[contenteditable='true']","[role='textbox']",
    "textarea[placeholder*='message' i]","textarea[placeholder*='mensaje' i]","textarea[placeholder*='escribe' i]",
    "input[name*='message' i]","div[data-testid*='input' i]",
    "div[data-placeholder*='mensaje' i]","div[data-placeholder*='message' i]"
  ],
  sendButton: "button:has-text('Send'), [aria-label='Send'], [data-testid='send'], button:has-text('Enviar')"
};
async function extractText(sel){ return page.evaluate(s => (document.querySelector(s)?.innerText)||"", sel); }
async function getContextText(){
  const chatText = await extractText(SELECTORS.chatArea);
  let perfil = "";
  try {
    perfil = await page.evaluate(() => {
      const node = Array.from(document.querySelectorAll("*")).find(n => /YOU ARE/i.test(n.innerText||""));
      const box = node?.closest("aside") || node?.parentElement;
      return box ? box.innerText : (node?.innerText||"");
    });
  } catch {}
  return { chat:(chatText||"").split("\n").slice(-40).join("\n"), perfil };
}
function ensureMinLength(text){
  const fillers = [
    " Me gusta hablar con calma y con buen rollo; así nos conocemos mejor y todo fluye.",
    " Cuéntame cómo te va el día o qué te apetece ahora; me hace ilusión saberlo y seguir charlando."
  ];
  let out = (text||"").trim();
  if (!/[?？]\s*$/.test(out)) { out = out.replace(/[.!…]*\s*$/, ""); out += " ¿Tú qué opinas?"; }
  while (out.length < MIN_CHARS) {
    out += fillers[(out.length/80|0)%fillers.length];
    if (!/[?？]\s*$/.test(out)) out += " ¿Qué te gustaría ahora?";
  }
  return out;
}
function buildPrompt({chat,perfil}){
  return `
Actúa como el personaje indicado y responde en español de España con tono cercano y sugerente sin ser explícito.
Cumple SIEMPRE: no insultos, no quedar en persona, no revelar identidad real, evita regionalismos de LATAM
(celular, vos, qué rico, recién, ahorita, computadora, etc.).
Longitud objetivo: 220–260 caracteres (si queda corto, alarga con frases naturales). Termina SIEMPRE con una pregunta abierta.

Personaje (panel "YOU ARE"):
${perfil || "No disponible"}

Últimos mensajes:
${chat || "No disponible"}

Da SOLO la respuesta final, sin comillas.`.trim();
}
async function generateReply(chat,perfil){
  const body = { model: MODEL, temperature:0.7, messages:[
    { role:"system", content:"Escribe español de España. Cumple normas: sin insultos, sin quedadas, sin identidad real." },
    { role:"user", content: buildPrompt({chat,perfil}) }
  ]};
  const r = await fetchFn("https://api.openai.com/v1/chat/completions",{
    method:"POST", headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,"Content-Type":"application/json"},
    body:JSON.stringify(body)
  });
  const data = await r.json();
  let text = data?.choices?.[0]?.message?.content?.trim() || "";
  text = ensureMinLength(text);
  const lower = text.toLowerCase();
  for (const w of BANNED) if (lower.includes(w)) { text = await generateRepair(text); break; }
  return ensureMinLength(text);
}
async function generateRepair(prev){
  const body = { model: MODEL, temperature:0.6, messages:[
    { role:"system", content:"Reescribe a español de España, sin regionalismos LATAM, cumpliendo normas." },
    { role:"user", content:`Reformula esto a 220–260 caracteres y termina con pregunta abierta:\n${prev}` }
  ]};
  const r = await fetchFn("https://api.openai.com/v1/chat/completions",{
    method:"POST", headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,"Content-Type":"application/json"},
    body:JSON.stringify(body)
  });
  const data = await r.json();
  return data?.choices?.[0]?.message?.content?.trim() || prev;
}
async function findInputHandle(){
  await nukeOverlays(page);
  for (const sel of SELECTORS.inputCandidates){
    const h = page.locator(sel).last();
    if (await h.count()) { try { if (await h.isVisible({timeout:200})) return h; } catch {} }
  }
  return null;
}
async function waitForInput(ms=10000){
  const end = Date.now()+ms;
  while (Date.now()<end){
    const h = await findInputHandle();
    if (h) return h;
    await page.waitForTimeout(300);
  }
  return null;
}
async function sendMessage(text){
  await dismissOnboardingWizard(page);
  const input = await waitForInput(10000);
  if (!input){ console.log("Input no disponible; reintento más tarde."); return false; }
  await nukeOverlays(page);
  try { await input.click({ timeout:2500, force:true }); } catch {}
  try { await input.fill(text); } catch { await page.keyboard.type(text); }
  await nukeOverlays(page);
  const btn = page.locator(SELECTORS.sendButton).first();
  if (await btn.count()){
    try { await btn.click({ timeout:2500 }); }
    catch { await btn.click({ timeout:2500, force:true }); }
  } else {
    await page.keyboard.press("Enter");
  }
  return true;
}

/* ============== Loop principal ============== */
async function loginIfNeeded(){
  await page.goto(BASE_URL, { waitUntil:"domcontentloaded" });
  await acceptCookiesAnywhere(page);
  await dismissOnboardingWizard(page);
  await nukeOverlays(page);

  if (await isQueueVisible()) return;
  if (await isLoginForm()) await performLogin();

  await page.waitForLoadState("domcontentloaded").catch(()=>{});
  await dismissOnboardingWizard(page);
  await nukeOverlays(page);
  await page.waitForTimeout(400);
}

async function loop(){
  await ensureBrowser();
  await loginIfNeeded();

  while (true){
    try{
      if (!running){ await page.waitForTimeout(1200); continue; }

      if (await isLoginForm()){ await performLogin(); await page.waitForTimeout(1200); continue; }

      await dismissOnboardingWizard(page);
      await nukeOverlays(page);

      if (await tryStartChatting()){ await page.waitForTimeout(1200); continue; }
      if (await isQueueVisible()){ await page.waitForTimeout(3500); continue; }

      const { chat, perfil } = await getContextText();
      if (!chat || chat.length < 10){ await page.waitForTimeout(1800); continue; }

      const reply = await generateReply(chat, perfil);
      const sent = await sendMessage(reply);
      if (!sent){ await page.waitForTimeout(1800); continue; }

      await page.waitForTimeout(2800 + Math.floor(Math.random()*1800));
    } catch(e){
      console.error("Loop error:", e?.message || e);
      if (String(e).includes("has been closed")){
        try{ await context?.close(); }catch{}
        try{ await browser?.close(); }catch{}
        browser=context=page=null;
        await ensureBrowser();
        await loginIfNeeded();
      } else {
        await page.waitForTimeout(1200);
      }
    }
  }
}

/* ============== Control endpoints ============== */
function checkToken(req,res,next){ if(req.query.token!==CONTROL_TOKEN) return res.status(401).send("unauthorized"); next(); }
app.get("/", (_,res)=>res.send("OK"));
app.get("/health", (_,res)=>res.json({ running }));
app.post("/pause", checkToken, (_,res)=>{ running=false; res.json({ running }); });
app.post("/resume", checkToken, (_,res)=>{ running=true; res.json({ running }); });
app.get("/screenshot", checkToken, async (_,res)=>{ if(!page) return res.status(500).send("page not ready"); const buf=await page.screenshot({ fullPage:true }); res.setHeader("Content-Type","image/png"); res.send(buf); });
app.get("/html", checkToken, async (_,res)=>{ if(!page) return res.status(500).send("page not ready"); res.setHeader("Content-Type","text/plain; charset=utf-8"); res.send(await page.content()); });

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server listening on", port);
  (async function run(){ try{ await loop(); } catch(e){ console.error("Top-level error:", e); setTimeout(run, 2000); }})();
});
