require("dotenv").config();
const express = require("express");
const { chromium } = require("playwright");

// fetch compatible
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

// palabras LATAM prohibidas
const BANNED = [
  "celular", "vos ", "qué rico", "recién", "ahorita", "computadora",
  "cachetadas", "jalar", "platicar", "carro", "papi", "lechita", "coger "
];

/* =============== helpers UI =============== */
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
      const b = p.getByRole("button",{name:t});
      if (await b.count()) { if (await b.first().isVisible({timeout:300})) { await b.first().click({timeout:1500}); await p.waitForTimeout(200); } }
    } catch {}
  }
}
async function clearOverlays(p) {
  try {
    await p.evaluate(() => {
      const sels = [
        "[data-testid='claimedNotification']",
        ".chat-claimed-notification",
        ".toast", ".Toastify", "[role='dialog'][aria-modal='true']",
        ".front-title.d-flex.flex-column.align-center.justify-center"
      ];
      for (const sel of sels) document.querySelectorAll(sel).forEach(el => { try{ el.style.pointerEvents="none"; el.style.display="none"; el.remove?.(); }catch{} });
    });
  } catch {}
}

/* =============== wizard inicial =============== */
async function dismissOnboardingWizard(p) {
  for (let i=0;i<12;i++){
    await acceptCookiesAnywhere(p);
    await clickIfVisible(p.getByRole("button",{name:/close|cerrar|entendido|hecho|ok/i}));
    const hasNext = await p.getByRole("button",{name:/next|siguiente/i}).count();
    if (hasNext) { await clickIfVisible(p.getByRole("button",{name:/next|siguiente/i})); await p.waitForTimeout(150); continue; }
    const visible = await p.getByText(/información importante sobre expresiones/i).first().isVisible().catch(()=>false);
    if (!visible) break;
    await p.waitForTimeout(120);
  }
}

/* =============== navegador =============== */
async function ensureBrowser() {
  if (browser && !browser.isConnected?.()) { try{ await browser.close(); }catch{} browser=null; }
  if (!browser) {
    browser = await chromium.launch({ headless:true, args:["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"] });
  }
  if (!context) {
    context = await browser.newContext({
      viewport:{width:1366,height:900},
      locale:"es-ES",
      timezoneId:"Europe/Madrid",
      userAgent:"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    });
  }
  if (!page || page.isClosed()) page = await context.newPage();
}

/* =============== login específico =============== */
async function isLoginForm() {
  try {
    const email = page.locator('input[placeholder="Email"], input[placeholder*="email" i]');
    const pass  = page.locator('input[placeholder="Password"], input[type="password"]');
    return (await email.count()) && (await pass.count());
  } catch { return false; }
}

async function performLogin() {
  const email = page.locator('input[placeholder="Email"], input[placeholder*="email" i]').first();
  const pass  = page.locator('input[placeholder="Password"], input[type="password"]').first();
  if (!(await email.count()) || !(await pass.count())) return false;

  await email.click({timeout:2000}); await email.fill(EMAIL, {timeout:2000});
  await pass.click({timeout:2000});  await pass.fill(PASSWORD, {timeout:2000});

  // botón SIGN IN
  let btn = page.getByRole("button",{name:/sign in|login|entrar|iniciar sesión/i}).first();
  if (!(await btn.count())) btn = page.locator('button[type="submit"]').first();

  // esperar a que se habilite
  try {
    await page.waitForFunction(b => !b.hasAttribute("disabled"), btn, { timeout: 2000 });
  } catch {}
  try { await btn.click({timeout:2000}); } catch { await pass.press("Enter"); }

  // esperar resultado: o dashboard/cola o error
  const ok = await page.waitForFunction(() => {
    const t = document.body.innerText || "";
    return /Waiting for conversation to be claimed/i.test(t) || /START CHATTING/i.test(t);
  }, { timeout: 8000 }).catch(()=>null);

  // si hay error visible, lo logeamos
  try {
    const err = await page.locator(".error, .alert, [role='alert']").first();
    if (await err.count()) console.log("Login error text:", await err.innerText());
  } catch {}

  return !!ok;
}

async function isQueueVisible() {
  const wait = await page.getByText(/Waiting for conversation to be claimed/i).first().isVisible().catch(()=>false);
  const startBtn = await page.getByRole("button",{name:/start chatting|start chat|start/i}).first().isVisible().catch(()=>false);
  return wait || startBtn;
}
async function tryStartChatting() {
  await clearOverlays(page);
  const locs = [
    page.getByRole("button",{name:/start chatting|start chat|start/i}),
    page.getByText(/^START CHATTING$/i),
    page.locator("[data-testid='start-chatting'], [data-test='start-chatting']")
  ];
  for (const l of locs) {
    try { const el = l.first(); if (await el.isVisible({timeout:200})) { await el.click({timeout:1200}); await page.waitForTimeout(600); return true; } } catch {}
  }
  return false;
}

async function loginIfNeeded() {
  await page.goto(BASE_URL, { waitUntil:"domcontentloaded" });
  await acceptCookiesAnywhere(page);
  await dismissOnboardingWizard(page);
  await clearOverlays(page);

  // ya dentro
  if (await isQueueVisible()) return;

  // ¿vemos login?
  if (await isLoginForm()) {
    const ok = await performLogin();
    if (!ok) console.log("Login no confirmado; reintento más tarde.");
  }

  await page.waitForLoadState("domcontentloaded");
  await dismissOnboardingWizard(page);
  await clearOverlays(page);
  await page.waitForTimeout(500);
}

/* =============== chat =============== */
const SELECTORS = {
  chatArea: "main, div[role='main'], div[data-testid='chat']",
  inputCandidates: [
    "textarea",
    "div[contenteditable='true']",
    "[role='textbox']",
    "textarea[placeholder*='message' i]",
    "textarea[placeholder*='mensaje' i]",
    "textarea[placeholder*='escribe' i]",
    "input[name*='message' i]",
    "div[data-testid*='input' i]",
    "div[data-placeholder*='mensaje' i]",
    "div[data-placeholder*='message' i]"
  ],
  sendButton: "button:has-text('Send'), [aria-label='Send'], [data-testid='send'], button:has-text('Enviar')"
};

async function extractText(sel) {
  return page.evaluate(s => (document.querySelector(s)?.innerText) || "", sel);
}
async function getContextText() {
  const chatText = await extractText(SELECTORS.chatArea);
  let perfil = "";
  try {
    perfil = await page.evaluate(() => {
      const node = Array.from(document.querySelectorAll("*")).find(n => /YOU ARE/i.test(n.innerText||""));
      const box = node?.closest("aside") || node?.parentElement;
      return box ? box.innerText : (node?.innerText || "");
    });
  } catch {}
  return {
    chat: (chatText||"").split("\n").slice(-40).join("\n"),
    perfil
  };
}

function ensureMinLength(text) {
  const fillers = [
    " Me gusta hablar con calma y con buen rollo; así nos conocemos mejor y todo fluye.",
    " Cuéntame cómo te va el día o qué te apetece ahora; me hace ilusión saberlo y seguir charlando."
  ];
  let out = (text||"").trim();
  if (!/[?？]\s*$/.test(out)) { out = out.replace(/[.!…]*\s*$/, ""); out += " ¿Tú qué opinas?"; }
  while (out.length < MIN_CHARS) {
    out += fillers[(out.length/80)|0 % fillers.length];
    if (!/[?？]\s*$/.test(out)) out += " ¿Qué te gustaría ahora?";
  }
  return out;
}
function buildPrompt({ chat, perfil }) {
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
async function generateReply(chat, perfil) {
  const body = {
    model: MODEL, temperature: 0.7,
    messages: [
      { role: "system", content: "Escribe español de España. Cumple normas: sin insultos, sin quedadas, sin identidad real." },
      { role: "user", content: buildPrompt({ chat, perfil }) }
    ]
  };
  const r = await fetchFn("https://api.openai.com/v1/chat/completions", {
    method:"POST", headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,"Content-Type":"application/json"}, body:JSON.stringify(body)
  });
  const data = await r.json();
  let text = data?.choices?.[0]?.message?.content?.trim() || "";
  text = ensureMinLength(text);
  const lower = text.toLowerCase();
  for (const w of BANNED) if (lower.includes(w)) return ensureMinLength(await generateRepair(text));
  return text;
}
async function generateRepair(prev) {
  const body = {
    model: MODEL, temperature: 0.6,
    messages: [
      { role: "system", content: "Reescribe a español de España, sin regionalismos LATAM, cumpliendo normas." },
      { role: "user", content: `Reformula esto a 220–260 caracteres y termina con pregunta abierta:\n${prev}` }
    ]
  };
  const r = await fetchFn("https://api.openai.com/v1/chat/completions", {
    method:"POST", headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,"Content-Type":"application/json"}, body:JSON.stringify(body)
  });
  const data = await r.json();
  return data?.choices?.[0]?.message?.content?.trim() || prev;
}
async function findInputHandle() {
  await clearOverlays(page);
  for (const sel of SELECTORS.inputCandidates) {
    const h = page.locator(sel).last();
    if (await h.count()) { try { if (await h.isVisible({timeout:200})) return h; } catch {} }
  }
  return null;
}
async function waitForInput(ms=10000) {
  const end = Date.now()+ms;
  while (Date.now()<end) {
    const h = await findInputHandle();
    if (h) return h;
    await page.waitForTimeout(300);
  }
  return null;
}
async function sendMessage(text) {
  await dismissOnboardingWizard(page);
  const input = await waitForInput(10000);
  if (!input) { console.log("Input no disponible; reintento más tarde."); return false; }
  await clearOverlays(page);
  try { await input.click({ timeout: 2500, force:true }); } catch {}
  try { await input.fill(text); } catch { await page.keyboard.type(text); }
  await clearOverlays(page);
  const btn = page.locator(SELECTORS.sendButton).first();
  if (await btn.count()) { try { await btn.click({timeout:2500}); } catch { await btn.click({timeout:2500, force:true}); } }
  else { await page.keyboard.press("Enter"); }
  return true;
}

/* =============== bucle principal =============== */
async function loop() {
  await ensureBrowser();
  await loginIfNeeded();

  while (true) {
    try {
      if (!running) { await page.waitForTimeout(1200); continue; }

      await dismissOnboardingWizard(page);
      await clearOverlays(page);

      // botón START CHATTING
      if (await tryStartChatting()) { await page.waitForTimeout(1200); continue; }

      // aún en cola → esperar
      if (await isQueueVisible()) { await page.waitForTimeout(3500); continue; }

      const { chat, perfil } = await getContextText();
      if (!chat || chat.length < 10) { await page.waitForTimeout(1800); continue; }

      const reply = await generateReply(chat, perfil);
      const sent = await sendMessage(reply);
      if (!sent) { await page.waitForTimeout(1800); continue; }

      await page.waitForTimeout(2800 + Math.floor(Math.random()*1800));
    } catch (e) {
      console.error("Loop error:", e?.message || e);
      // si la página o contexto se cerraron, recrea
      if (String(e).includes("has been closed")) {
        try { await context?.close(); } catch {}
        try { await browser?.close(); } catch {}
        browser = context = page = null;
        await ensureBrowser();
        await loginIfNeeded();
      } else {
        await page.waitForTimeout(1200);
      }
    }
  }
}

/* =============== endpoints control =============== */
function checkToken(req,res,next){ if(req.query.token!==CONTROL_TOKEN) return res.status(401).send("unauthorized"); next(); }
app.get("/", (_,res)=>res.send("OK"));
app.get("/health", (_,res)=>res.json({ running }));
app.post("/pause", checkToken, (_,res)=>{ running=false; res.json({ running }); });
app.post("/resume", checkToken, (_,res)=>{ running=true; res.json({ running }); });
app.get("/screenshot", checkToken, async (_,res)=>{ if(!page) return res.status(500).send("page not ready"); const buf=await page.screenshot({fullPage:true}); res.setHeader("Content-Type","image/png"); res.send(buf); });
app.get("/html", checkToken, async (_,res)=>{ if(!page) return res.status(500).send("page not ready"); res.setHeader("Content-Type","text/plain; charset=utf-8"); res.send(await page.content()); });

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server listening on", port);
  (async function run(){ try{ await loop(); } catch(e){ console.error("Top-level error:", e); setTimeout(run, 2000); }})();
});
