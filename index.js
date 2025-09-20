require("dotenv").config();
const express = require("express");
const { chromium } = require("playwright");

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

// Lista básica de palabras/expresiones vetadas por la plataforma (puedes ampliar)
const BANNED = [
  "celular", "vos ", "qué rico", "recién", "ahorita", "computadora",
  "cachetadas", "jalar", "platicar", "carro", "papi", "lechita",
  "coger" // en sentido sexual; el modelo ya entiende el matiz si se lo pides
];

// Prompt maestro: español de España + 150+ caracteres + terminar con pregunta abierta
function buildPrompt({ chat, perfil }) {
  return `
Actúa como el personaje indicado y responde en **español de España** con tono cercano y sugerente sin ser explícito.
Cumple SIEMPRE: no insultos, no quedar en persona, no revelar identidad real, evita regionalismos de LATAM
(celular, vos, qué rico, recién, ahorita, computadora, etc.).
Longitud objetivo: 170–210 caracteres (mínimo 150). Termina SIEMPRE con una pregunta abierta.

Personaje (lo que ves en "YOU ARE"):
${perfil || "No disponible"}

Últimos mensajes (formato texto plano):
${chat || "No disponible"}

Da SOLO la respuesta final, sin comillas, lista para pegar.`;
}

// Llama al LLM (OpenAI Chat Completions compatible)
async function generateReply(chat, perfil) {
  const body = {
    model: MODEL,
    temperature: 0.7,
    messages: [
      { role: "system", content: "Eres un asistente que escribe español de España, siguiendo normas del chat." },
      { role: "user", content: buildPrompt({ chat, perfil }) }
    ]
  };
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  let text = data?.choices?.[0]?.message?.content?.trim() || "";

  // Post-filtro: longitud y palabras vetadas
  if (text.length < 150) {
    text += " ¿Y tú qué opinas?"; // estira un poco si se quedó corto
  }
  const lower = text.toLowerCase();
  for (const w of BANNED) {
    if (lower.includes(w)) {
      // Reescribe pidiendo español de España
      return generateRepair(text);
    }
  }
  return text;
}

async function generateRepair(prev) {
  const body = {
    model: MODEL,
    temperature: 0.6,
    messages: [
      { role: "system", content: "Reescribe a español de España cumpliendo normas y evita regionalismos LATAM." },
      { role: "user", content: `Reformula este texto manteniendo el sentido, 170–210 caracteres, termina con pregunta abierta:\n${prev}` }
    ]
  };
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
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
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
}

async function loginIfNeeded() {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

  // Intenta detectar si ya está logueado (selector de espera)
  const waitingSelector = "text=Waiting for conversation to be claimed";
  const isWaiting = await page.$(waitingSelector);
  if (isWaiting) return;

  // Rellena login (ajusta selectores si cambian)
  const emailSel = 'input[type="email"], input[name="email"]';
  const passSel = 'input[type="password"], input[name="password"]';
  await page.waitForSelector(emailSel, { timeout: 15000 });
  await page.fill(emailSel, EMAIL);
  await page.fill(passSel, PASSWORD);

  // Botón de entrar (ajusta el texto si es distinto)
  const loginButton = await page.$('button:has-text("Login"), button:has-text("Iniciar sesión")');
  if (loginButton) {
    await loginButton.click();
  } else {
    // Si no encuentra botón, prueba Enter
    await page.press(passSel, "Enter");
  }

  await page.waitForLoadState("domcontentloaded");
}

async function extractText(selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.innerText : "";
  }, selector);
}

// Configurable: ajusta estas rutas si cambian
const SELECTORS = {
  waiting: "text=Waiting for conversation to be claimed",
  chatArea: "main, div[role='main'], div[data-testid='chat']", // área central
  youArePanel: "text=YOU ARE", // punto de anclaje; luego cogemos el bloque cercano
  inputBox: "textarea, div[contenteditable='true']",
  sendButton: "button:has-text('Send'), [aria-label='Send'], [data-testid='send']"
};

async function getContextText() {
  // Intenta sacar todo el texto del área de chat
  const chatText = await extractText(SELECTORS.chatArea);
  // Intenta sacar el panel de "YOU ARE" (puede requerir ajustar)
  let perfil = "";
  try {
    perfil = await page.evaluate(() => {
      const node = Array.from(document.querySelectorAll("*"))
        .find(n => /YOU ARE/i.test(n.innerText || ""));
      if (!node) return "";
      // Coge el contenedor padre cercano
      const box = node.closest("aside") || node.parentElement;
      return box ? box.innerText : node.innerText;
    });
  } catch { /* ignore */ }

  // Recorta a lo último para no mandar demasiado texto
  const trimmedChat = chatText.split("\n").slice(-40).join("\n");
  return { chat: trimmedChat, perfil };
}

async function sendMessage(text) {
  // Escribe y envía
  const input = await page.$(SELECTORS.inputBox);
  if (!input) throw new Error("No encuentro el cuadro de texto.");
  await input.click();
  await input.fill(text);
  const btn = await page.$(SELECTORS.sendButton);
  if (btn) {
    await btn.click();
    // A veces Enter también envía si el botón no reacciona
  } else {
    await page.keyboard.press("Enter");
  }
}

async function loop() {
  await ensureBrowser();
  await loginIfNeeded();

  while (true) {
    if (!running) { await page.waitForTimeout(1500); continue; }

    // Espera a que haya conversación o permanece en la cola
    const waiting = await page.$(SELECTORS.waiting);
    if (waiting) {
      await page.waitForTimeout(4000);
      continue; // sigue esperando hasta que asignen chat
    }

    // Ya hay chat: coge contexto, genera y envía
    const { chat, perfil } = await getContextText();
    if (!chat || chat.length < 10) {
      // puede que todavía esté cargando
      await page.waitForTimeout(2000);
      continue;
    }

    const reply = await generateReply(chat, perfil);
    await sendMessage(reply);

    // Tras enviar, vuelve a pantalla de espera (según tu flujo)
    await page.waitForTimeout(3000);
    // Busca si reaparece el estado de espera (si no, seguirá en el mismo chat)
    // En ambos casos, el bucle continúa.
  }
}

// ---- Endpoints de control (con token simple) ----
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
app.listen(port, async () => {
  console.log("Server listening on", port);
  try { await loop(); } catch (e) { console.error(e); process.exit(1); }
});
