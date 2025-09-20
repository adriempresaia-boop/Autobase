require("dotenv").config();
const express = require("express");
const { chromium } = require("playwright");

// FETCH robusto
const fetchFn = globalThis.fetch
  ? (...args) => globalThis.fetch(...args)
  : (...args) => import("node-fetch").then(({ default: f }) => f(...args));

process.on("unhandledRejection", (e) => console.error("UNHANDLED_REJECTION", e));
process.on("uncaughtException", (e) => console.error("UNCAUGHT_EXCEPTION", e));

const {
  EMAIL,
  PASSWORD,
  OPENAI_API_KEY,
  BASE_URL = "https://chathomebase.com/login",
  MODEL = "gpt-4o-mini",
  CONTROL_TOKEN = "change_me"
} = process.env;

const app = express();
app.use(express.json());

let running = true;
let browser, context, page;

const BANNED = [
  "celular", "vos ", "qué rico", "recién", "ahorita", "computadora",
  "cachetadas", "jalar", "platicar", "carro", "papi", "lechita", "coger "
];

/* ===========================
   Helpers de UI / Overlays
   =========================== */

async function clickIfVisible(locator) {
  try {
    const el = locator.first();
    if (await el.isVisible({ timeout: 500 })) {
      await el.click({ timeout: 2000 });
      return true;
    }
  } catch {}
  return false;
}

async function acceptCookiesAnywhere(p) {
  const texts = [
    /accept all/i, /accept/i, /agree/i, /allow all/i,
    /aceptar todas/i, /aceptar/i, /entendido/i
  ];
  for (const t of texts) {
    try {
      const btn = p.getByRole("button", { name: t });
      if (await btn.count()) {
        if (await btn.first().isVisible({ timeout: 500 })) {
          await btn.first().click({ timeout: 2000 });
          await p.waitForTimeout(400);
          break;
        }
      }
    } catch {}
  }
}

// Quita overlays que interceptan eventos (como claimedNotification)
async function clearOverlays(p) {
  try {
    await p.evaluate(() => {
      const sels = [
        "[data-testid='claimedNotification']",
        ".chat-claimed-notification",
        ".toast", ".Toastify", "[role='dialog']",
        ".front-title.d-flex.flex-column.align-center.justify-center"
      ];
      for (const sel of sels) {
        document.querySelectorAll(sel).forEach(el => {
          el.style.pointerEvents = "none";
          el.style.display = "none";
          el.remove?.();
        });
      }
    });
  } catch {}
}

async function findEmailInput(p) {
  let el = p.getByRole("textbox", { name: /email/i });
  if (await el.count()) return el.first();
  el = p.locator('input[placeholder*="email" i], input[name*="email" i], input[type="email"]');
  if (await el.count()) return el.first();
  return null;
}
async function findPasswordInput(p) {
  let el = p.getByRole("textbox", { name: /contraseña|password/i });
  if (await el.count()) return el.first();
  el = p.locator('input[placeholder*="contraseña" i], input[placeholder*="password" i], input[name*="pass" i], input[type="password"]');
  if (await el.count()) return el.first();
  return null;
}
async function findSubmitButton(p) {
  let b = p.getByRole("button", { name: /login|sign in|iniciar sesión|entrar/i });
  if (await b.count()) return b.first();
  b = p.locator('button[type="submit"]');
  if (await b.count()) return b.first();
  return null;
}

async function smartFillInAnyFrame() {
  const all = [page, ...page.frames()];
  for (const ctx of all) {
    try {
      await clearOverlays(ctx);
      const email = await findEmailInput(ctx);
      const pass  = await findPasswordInput(ctx);
      if (email && pass) {
        await email.click({ timeout: 3000 });
        await email.fill(EMAIL, { timeout: 3000 });
        await pass.click({ timeout: 3000 });
        await pass.fill(PASSWORD, { timeout: 3000 });
        const btn = await findSubmitButton(ctx);
        if (btn) { await btn.click({ timeout: 3000 }); return true; }
        await pass.press("Enter");
        return true;
      }
    } catch {}
  }
  return false;
}

/* ===========================
   Navegador y Login
   =========================== */

async function ensureBrowser() {
  if (browser) return;
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });
  context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    locale: "es-ES",
    timezoneId: "Europe/Madrid",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  });
  page = await context.newPage();
}

async function loginIfNeeded() {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await acceptCookiesAnywhere(page);
  await clearOverlays(page);

  // ¿Ya estamos dentro?
  if (await page.locator("text=Waiting for conversation to be claimed").first().isVisible().catch(()=>false)) return;

  // A veces hay "CHAT" o un botón para abrir el login
  await clickIfVisible(page.getByText(/^CHAT$/i));
  await clickIfVisible(page.getByRole("button", { name: /login|entrar|iniciar sesión|sign in/i }));
  await page.waitForTimeout(500);
  await acceptCookiesAnywhere(page);
  await clearOverlays(page);

  // Intenta rellenar
  const done = await smartFillInAnyFrame();
  if (!done) {
    const deadline = Date.now() + 35000;
    while (Date.now() < deadline) {
      await clearOverlays(page);
      if (await smartFillInAnyFrame()) break;
      await clickIfVisible(page.getByRole("button", { name: /email/i }));
      await clickIfVisible(page.getByText(/email/i));
      await page.waitForTimeout(1000);
    }
  }

  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1000);
}

/* ===========================
   Extracción, generación, envío
   =========================== */

async function extractText(selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.innerText : "";
  }, selector);
}

const SELECTORS = {
  waiting: "text=Waiting for conversation to be claimed",
  chatArea: "main, div[role='main'], div[data-testid='chat']",
  inputBox: "textarea, div[contenteditable='true']",
  sendButton: "button:has-text('Send'), [aria-label='Send'], [data-testid='send'], button:has-text('Enviar')"
};

async function getContextText() {
  const chatText = await extractText(SELECTORS.chatArea);

  let perfil = "";
  try {
    perfil = await page.evaluate(() => {
      const node = Array.from(document.querySelectorAll("*"))
        .find(n => /YOU ARE/i.test(n.innerText || ""));
      if (!node) return "";
      const box = node.closest("aside") || node.parentElement;
      return box ? box.innerText : node.innerText;
    });
  } catch {}
  const trimmedChat = (chatText || "").split("\n").slice(-40).join("\n");
  return { chat: trimmedChat, perfil };
}

function buildPrompt({ chat, perfil }) {
  return `
Actúa como el personaje indicado y responde en español de España con tono cercano y sugerente sin ser explícito.
Cumple SIEMPRE: no insultos, no quedar en persona, no revelar identidad real, evita regionalismos de LATAM
(celular, vos, qué rico, recién, ahorita, computadora, etc.).
Longitud objetivo: 170–210 caracteres (mínimo 150). Termina SIEMPRE con una pregunta abierta.

Personaje (panel "YOU ARE"):
${perfil || "No disponible"}

Últimos mensajes:
${chat || "No disponible"}

Da SOLO la respuesta final, sin comillas.`; }

async function generateReply(chat, perfil) {
  const body = {
    model: MODEL,
    temperature: 0.7,
    messages: [
      { role: "system", content: "Escribe español de España. Cumple normas: sin insultos, sin quedadas, sin identidad real." },
      { role: "user", content: buildPrompt({ chat, perfil }) }
    ]
  };
  const res = await fetchFn("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  let text = data?.choices?.[0]?.message?.content?.trim() || "";
  if (text.length < 150) text += " ¿Tú cómo lo ves?";
  const lower = text.toLowerCase();
  for (const w of BANNED) if (lower.includes(w)) return generateRepair(text);
  return text;
}

async function generateRepair(prev) {
  const body = {
    model: MODEL,
    temperature: 0.6,
    messages: [
      { role: "system", content: "Reescribe a español de España, sin regionalismos LATAM, cumpliendo normas." },
      { role: "user", content: `Reformula esto a 170–210 caracteres y termina con pregunta abierta:\n${prev}` }
    ]
  };
  const res = await fetchFn("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || prev;
}

async function sendMessage(text) {
  await clearOverlays(page);
  const input = await page.locator(SELECTORS.inputBox).first();
  if (!(await input.count())) throw new Error("No encuentro el cuadro de texto.");
  await input.click({ timeout: 3000, force: true });
  await input.fill(text);

  await clearOverlays(page);
  const btn =
    (await page.locator(SELECTORS.sendButton).first()) ||
    null;
  if (btn && (await btn.count())) {
    try { await btn.click({ timeout: 3000 }); }
    catch { await btn.click({ timeout: 3000, force: true }); }
  } else {
    await page.keyboard.press("Enter");
  }
}

async function loop() {
  await ensureBrowser();
  await loginIfNeeded();

  while (true) {
    if (!running) { await page.waitForTimeout(1500); continue; }

    if (await page.locator(SELECTORS.waiting).first().isVisible().catch(()=>false)) {
      await clearOverlays(page);
      await page.waitForTimeout(4000);
      continue;
    }

    const { chat, perfil } = await getContextText();
    if (!chat || chat.length < 10) { await page.waitForTimeout(2000); continue; }

    const reply = await generateReply(chat, perfil);
    await sendMessage(reply);

    await page.waitForTimeout(3000 + Math.floor(Math.random() * 2000));
  }
}

/* ===========================
   Endpoints control
   =========================== */

function checkToken(req, res, next) {
  if (req.query.token !== CONTROL_TOKEN) return res.status(401).send("unauthorized");
  next();
}
app.get("/", (req, res) => res.send("OK"));
app.get("/health", (req, res) => res.json({ running }));
app.post("/pause", checkToken, (req, res) => { running = false; res.json({ running }); });
app.post("/resume", checkToken, (req, res) => { running = true; res.json({ running }); });
app.get("/screenshot", checkToken, async (req, res) => {
  if (!page) return res.status(500).send("page not ready");
  const buf = await page.screenshot({ fullPage: true });
  res.setHeader("Content-Type", "image/png");
  res.send(buf);
});
app.get("/html", checkToken, async (req, res) => {
  if (!page) return res.status(500).send("page not ready");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(await page.content());
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server listening on", port);
  const run = async () => {
    try { await loop(); }
    catch (e) { console.error("Loop error:", e); setTimeout(run, 3000); }
  };
  run();
});
