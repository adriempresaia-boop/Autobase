require("dotenv").config();
const express = require("express");
const { chromium } = require("playwright");

// FETCH robusto (sin top-level await)
const fetchFn = globalThis.fetch
  ? (...args) => globalThis.fetch(...args)
  : (...args) => import("node-fetch").then(({ default: f }) => f(...args));

// No tumbar el contenedor en errores no capturados
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

// Lista básica de palabras/expresiones vetadas por la plataforma (amplía si quieres)
const BANNED = [
  "celular", "vos ", "qué rico", "recién", "ahorita", "computadora",
  "cachetadas", "jalar", "platicar", "carro", "papi", "lechita", "coger "
];

// Prompt maestro
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

Da SOLO la respuesta final, sin comillas.`;
}

// Llama al LLM
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
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  let text = data?.choices?.[0]?.message?.content?.trim() || "";

  // Post-filtro
  if (text.length < 150) text += " ¿Tú cómo lo ves?";
  const lower = text.toLowerCase();
  for (const w of BANNED) {
    if (lower.includes(w)) return generateRepair(text);
  }
  return text;
}

// Reparación si detectamos palabras vetadas
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
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || prev;
}

async function ensureBrowser() {
  if (browser) return;
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
}

async function loginIfNeeded() {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

  // ¿Ya estamos en la pantalla de espera?
  const waitingSelector = "text=Waiting for conversation to be claimed";
  const isWaiting = await page.$(waitingSelector);
  if (isWaiting) return;

  // Rellena login (ajusta si cambian los selectores)
  const emailSel = 'input[type="email"], input[name="email"]';
  const passSel  = 'input[type="password"], input[name="password"]';
  await page.waitForSelector(emailSel, { timeout: 20000 });
  await page.fill(emailSel, EMAIL);
  await page.fill(passSel, PASSWORD);

  // Botón entrar (cubre varias variantes)
  const loginButton =
    (await page.$('button:has-text("Login")')) ||
    (await page.$('button:has-text("Iniciar sesión")')) ||
    (await page.$('button:has-text("Entrar")')) ||
    (await page.$('button[type="submit"]'));
  if (loginButton) await loginButton.click();
  else await page.press(passSel, "Enter");

  await page.waitForLoadState("domcontentloaded");
}

async function extractText(selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.innerText : "";
  }, selector);
}

// Selectores (ajústalos si cambia la UI)
const SELECTORS = {
  waiting: "text=Waiting for conversation to be claimed",
  chatArea: "main, div[role='main'], div[data-testid='chat']",
  inputBox: "textarea, div[contenteditable='true']",
  sendButton: "button:has-text('Send'), [aria-label='Send'], [data-testid='send']"
};

async function getContextText() {
  const chatText = await extractText(SELECTORS.chatArea);

  // Panel "YOU ARE": buscamos por texto y cogemos el contenedor cercano
  let perfil = "";
  try {
    perfil = await page.evaluate(() => {
      const node = Array.from(document.querySelectorAll("*"))
        .find(n => /YOU ARE/i.test(n.innerText || ""));
      if (!node) return "";
      const box = node.closest("aside") || node.parentElement;
      return box ? box.innerText : node.innerText;
    });
  } catch { /* ignore */ }

  const trimmedChat = (chatText || "").split("\n").slice(-40).join("\n");
  return { chat: trimmedChat, perfil };
}

async function sendMessage(text) {
  const input = await page.$(SELECTORS.inputBox);
  if (!input) throw new Error("No encuentro el cuadro de texto.");
  await input.click();
  await input.fill(text);

  const btn =
    (await page.$(SELECTORS.sendButton)) ||
    (await page.$('button:has-text("Enviar")'));
  if (btn) await btn.click();
  else await page.keyboard.press("Enter");
}

async function loop() {
  await ensureBrowser();
  await loginIfNeeded();

  while (true) {
    if (!running) { await page.waitForTimeout(1500); continue; }

    const waiting = await page.$(SELECTORS.waiting);
    if (waiting) {
      await page.waitForTimeout(4000);
      continue;
    }

    const { chat, perfil } = await getContextText();
    if (!chat || chat.length < 10) {
      await page.waitForTimeout(2000);
      continue;
    }

    const reply = await generateReply(chat, perfil);
    await sendMessage(reply);

    // Ritmo humano
    await page.waitForTimeout(3000 + Math.floor(Math.random() * 2000));
  }
}

// --- Endpoints de control ---
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

  // Arranca el loop con reintentos si falla
  const run = async () => {
    try { await loop(); }
    catch (e) { console.error("Loop error:", e); setTimeout(run, 3000); }
  };
  run();
});
