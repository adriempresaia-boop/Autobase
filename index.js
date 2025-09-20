// index.js — Autobase (CommonJS, sin borrar nunca)
require("dotenv").config();
const express = require("express");
const { chromium } = require("playwright");

const {
  EMAIL,
  PASSWORD,
  OPENAI_API_KEY,
  MODEL = "gpt-4o-mini",
  BASE_URL = "https://chathomebase.com/login",
  CONTROL_TOKEN = "change_me",
  MIN_CHARS: MIN_CHARS_ENV
} = process.env;

const MIN_CHARS = Number(MIN_CHARS_ENV || 170);
const CHAT_LAST_LINES = 8;

let browser, context, page;
let running = true;

const app = express();
app.use(express.json());
const log = (...a)=>console.log(new Date().toISOString(), ...a);

// fetch compatible
const fetchFn = globalThis.fetch
  ? (...a)=>globalThis.fetch(...a)
  : (...a)=>import("node-fetch").then(({default:f})=>f(...a));

// Palabras a evitar (latam + prohibidas)
const BANNED = [
  "celular","vos ","qué rico","recién","ahorita","computadora",
  "cachetadas","jalar","platicar","carro","papi","lechita"," coger "
];

// Normalizaciones a español ES
const REPLACEMENTS = [
  [/computadora/gi,"ordenador"],
  [/celular/gi,"móvil"],
  [/con gusto/gi,"encantado"],
  [/platicar/gi,"charlar"],
  [/carro/gi,"coche"],
  [/órale/gi,"vale"],
  [/ahorita/gi,"ahora"],
  [/vos(?:otros)?/gi,"tú"],
  [/\s+coger\s+/gi," tener "], // evitar sexual explícito
];

// ---------- Navegador ----------
async function ensureBrowser(){
  if (browser && !browser.isConnected?.()) { try{await browser.close();}catch{} browser=null; }
  if (!browser){
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage",
        "--disable-gpu","--no-zygote","--single-process",
        "--renderer-process-limit=1","--js-flags=--max-old-space-size=256"
      ]
    });
  }
  if (!context){
    context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      locale: "es-ES",
      timezoneId: "Europe/Madrid",
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
    });
  }
  if (!page || page.isClosed()) page = await context.newPage();
}

async function acceptCookiesAnywhere(p){
  const texts=[/aceptar/i,/aceptar todas/i,/ok/i,/entendido/i,/close/i,/agree/i,/accept/i];
  for (const t of texts){
    try{
      const b=p.getByRole("button",{name:t});
      if(await b.count() && await b.first().isVisible({timeout:200})) await b.first().click({timeout:800});
    }catch{}
  }
}

async function wizardVisible(p){
  try{
    return await p.getByText(/información importante sobre expresiones/i)
      .first().isVisible({timeout:200});
  }catch{return false;}
}

async function clickByTextEverywhere(p, regexes){
  return await p.evaluate((labels)=>{
    const txt = el => (el.innerText||el.textContent||"").trim();
    const vis = el => el && el.offsetParent!==null;
    const all = [...document.querySelectorAll('button,[role="button"],.v-btn,.btn')];
    for (const el of all){
      for (const re of labels){
        if (vis(el) && re.test(txt(el))) { try{ el.click(); return true; }catch{} }
      }
    }
    const modals=[...document.querySelectorAll('[role="dialog"], .v-dialog, .modal')];
    for(const m of modals){
      const btns=[...m.querySelectorAll('button,[role="button"],.v-btn,.btn')];
      for (const el of btns){
        for (const re of labels){
          if (vis(el) && re.test(txt(el))) { try{ el.click(); return true; }catch{} }
        }
      }
    }
    return false;
  }, regexes);
}

async function dismissOnboardingWizard(p){
  for (let i=0;i<18;i++){
    let clicked=false;
    try{
      clicked = await clickByTextEverywhere(p,[/^next$/i,/siguiente/i,/cerrar/i,/close/i,/entendido/i,/ok/i,/finalizar/i]);
    }catch{}
    if(!clicked){ try{ await p.keyboard.press("Enter"); }catch{} await p.waitForTimeout(90); }
    if(!(await wizardVisible(p))) return true;
  }
  try{
    await p.evaluate(()=>{
      const re=/información importante sobre expresiones/i;
      const d=[...document.querySelectorAll('[role="dialog"], .v-dialog, .modal')].find(n=>re.test(n.innerText||""));
      if(d){ d.style.display="none"; d.remove?.(); }
    });
  }catch{}
  return false;
}

const emailSel = 'input[type="email"], input[placeholder="Email"], input[name="email"]';
const passSel  = 'input[type="password"], input[placeholder="Password"], input[name*="pass" i]';
const signSel  = 'button:has-text("SIGN IN"), button:has-text("Sign in"), button:has-text("Login"), button:has-text("Entrar"), button[type="submit"]';

async function isLoginForm(){
  try { return (await page.locator(emailSel).count()) && (await page.locator(passSel).count()); }
  catch { return false; }
}
async function performLogin(){
  try{
    await page.locator(emailSel).first().fill(EMAIL);
    await page.locator(passSel).first().fill(PASSWORD);
  }catch{}
  try{ await page.locator(signSel).first().click(); }catch{ try{ await page.keyboard.press("Enter"); }catch{} }
  await page.waitForTimeout(500);
}

async function isQueueVisible(){
  const a = await page.getByText(/Waiting for conversation to be claimed/i).first().isVisible().catch(()=>false);
  const b = await page.getByRole("button",{ name:/start chatting|start/i }).first().isVisible().catch(()=>false);
  return a||b;
}
async function tryStartChatting(){
  const locs = [
    page.getByRole("button",{ name:/start chatting|start/i }),
    page.getByText(/^START CHATTING$/i)
  ];
  for(const l of locs){
    try{ const el=l.first(); if(await el.count()){ await el.click({timeout:700}).catch(()=>el.click({timeout:700,force:true})); return true; } }catch{}
  }
  return false;
}

async function getContextText(){
  const chatText = await page.evaluate(()=>{
    const sel = "main, div[role='main'], div[data-testid='chat']";
    const n = document.querySelector(sel);
    return n ? n.innerText : "";
  });
  let perfil = "";
  try{
    perfil = await page.evaluate(()=>{
      const n=[...document.querySelectorAll("*")].find(x=>/YOU ARE/i.test(x.innerText||""));
      const b=n?.closest("aside")||n?.parentElement;
      return b? b.innerText : (n?.innerText||"");
    });
  }catch{}
  return {
    chat:(chatText||"").split("\n").slice(-CHAT_LAST_LINES).join("\n"),
    perfil
  };
}

// ---------- Generación ----------
function sanitizeEs(text){
  let out=(text||"").trim();
  for (const [re,rep] of REPLACEMENTS) out = out.replace(re,rep);
  for (const w of BANNED) out = out.replace(new RegExp(w,"gi"),"");
  // quitar markdown raro
  out = out.replace(/[*_#>`~\[\]\(\)]/g,"").replace(/\s{2,}/g," ").trim();
  // asegurar cierre amable y pregunta
  if (!/[?¿]\s*$/.test(out)) { out = out.replace(/[.!…]*\s*$/, ""); out += " ¿Tú qué dirías?"; }
  return out;
}

function ensureMinLength(text){
  const fillers = [
    " Me apetece llevarlo con naturalidad y picardía, sin prisas.",
    " Si te parece, seguimos por ahí y vamos viendo con calma.",
    " Me gusta escucharte y jugar con esa chispa, a nuestro ritmo."
  ];
  let out=sanitizeEs(text);
  while(out.length<MIN_CHARS){
    out += " " + fillers[(out.length/33|0)%fillers.length];
    if (!/[?¿]\s*$/.test(out)) out += " ¿Te cuadra?";
  }
  return out;
}

function buildPrompt({chat,perfil}){
  return `
Escribe UNA respuesta breve en español de España, tono cercano y coqueto pero sin cruzar líneas, sin tacos, sin proponer quedar, sin datos personales ni enlaces.
Usa SOLO el contexto de los últimos mensajes, termina con una pregunta abierta. 180-230 caracteres aprox.

Evita latam: celular, vos, qué rico, recién, ahorita, computadora, jalar, platicar, carro, papi, lechita, "coger" (sexual).
No uses listas, emojis raros ni formato markdown.

Personaje (panel "YOU ARE"):
${perfil || "No disponible"}

Últimos mensajes:
${chat || "No disponible"}
`.trim();
}

const lastMessages = [];
const LAST_N = 12;

async function generateReply(chat,perfil){
  // Fallback local si no hay API
  async function local(){
    const last = (chat||"").split("\n").slice(-5).join(" ").trim();
    let s = last ? `Sobre lo que me cuentas: ${last}. ` : "";
    s += "Soy natural y juguetona; me gusta hablar con elegancia y chispa. ";
    s += "¿Seguimos por ahí y me cuentas un poco más?";
    s = ensureMinLength(s);
    if(lastMessages.includes(s)) s += " Me dejas con curiosidad.";
    lastMessages.push(s); while(lastMessages.length>LAST_N) lastMessages.shift();
    log("GEN fallback len=",s.length);
    return s;
  }

  if(!OPENAI_API_KEY) return await local();

  try{
    const r = await fetchFn("https://api.openai.com/v1/chat/completions",{
      method:"POST",
      headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,"Content-Type":"application/json"},
      body:JSON.stringify({
        model: MODEL,
        temperature: 0.9,
        messages:[
          {role:"system",content:"Responde en español de España. Cumple normas: nada de quedar, ni insultos, ni datos, ni contenido explícito."},
          {role:"user",content:buildPrompt({chat,perfil})}
        ]
      })
    });
    if(!r.ok) throw new Error("OpenAI "+r.status);
    const data=await r.json();
    let text=data?.choices?.[0]?.message?.content?.trim()||"";
    if(!text) throw new Error("empty");
    text = ensureMinLength(text);
    if(lastMessages.includes(text)) text += " Me encanta ese toque tuyo.";
    lastMessages.push(text); while(lastMessages.length>LAST_N) lastMessages.shift();
    log("GEN ok len=",text.length);
    return text;
  }catch(e){
    return await local();
  }
}

// ---------- Entrada y envío (sin borrar nunca) ----------
const SELECTORS = {
  inputCandidates: [
    "textarea",
    "div[contenteditable='true']",
    "[role='textbox']",
    "textarea[placeholder*='mensaje' i]",
    "textarea[placeholder*='message' i]",
    "div[data-placeholder*='mensaje' i]",
    "div[data-placeholder*='message' i]"
  ],
  sendButton:
    "button:has-text('Send'), [aria-label='Send'], [data-testid='send'], button:has-text('Enviar')",
  chatArea: "main, div[role='main'], div[data-testid='chat']"
};

async function findInputHandle(){
  for (const sel of SELECTORS.inputCandidates){
    try{
      const h=page.locator(sel).last();
      if(await h.count() && await h.isVisible({timeout:200})) return h;
    }catch{}
  }
  return null;
}
async function getInputValue(h){
  try{
    const el = await h.elementHandle();
    return await page.evaluate(n=>{
      if(!n) return "";
      if(n.tagName==="TEXTAREA") return n.value||"";
      if(n.getAttribute("contenteditable")==="true") return n.innerText||"";
      if(n.tagName==="INPUT") return n.value||"";
      return n.textContent||"";
    },el);
  }catch{return "";}
}

// Tecleo humano (SIN errores y SIN backspace)
async function humanType(h, text, mode="fast"){
  const perChar = mode==="slow" ? [65,110] : [33,70];
  const pauseWord = mode==="slow" ? [160,300] : [80,160];
  const pausePunct= mode==="slow" ? [300,620] : [180,360];

  await h.focus();
  const tokens = text.split(/(\s+)/); // conserva espacios
  for (const tk of tokens){
    for (const ch of tk){
      try{ await page.keyboard.type(ch,{delay: rand(perChar[0],perChar[1])}); }catch{}
    }
    if (/[\.\!\?\…]$/.test(tk)) await page.waitForTimeout(rand(pausePunct[0],pausePunct[1]));
    else await page.waitForTimeout(rand(pauseWord[0],pauseWord[1]));
  }
}

async function closeCopyWarning(){
  try{
    const was = await page.getByText(/copy paste warning|your text won't be inserted|no será insertado/i)
      .first().isVisible({timeout:200}).catch(()=>false);
    if (was){
      await clickByTextEverywhere(page,[/close/i,/cerrar/i,/ok/i,/entendido/i]);
      await page.waitForTimeout(120);
      return true;
    }
  }catch{}
  return false;
}

async function waitPosted(text, timeoutMs=6500){
  const before = await page.evaluate(sel => (document.querySelector(sel)?.innerText)||"", SELECTORS.chatArea);
  const snippet = (text||"").slice(0,45).replace(/\s+/g," ").trim();
  const end = Date.now()+timeoutMs;
  while(Date.now()<end){
    const now = await page.evaluate(sel => (document.querySelector(sel)?.innerText)||"", SELECTORS.chatArea);
    if (now.length>before.length && now.includes(snippet)) return true;
    await page.waitForTimeout(220);
  }
  return false;
}

async function sendMessage(text){
  try{
    // localizar input (sin limpiar)
    const end=Date.now()+7000;
    let input=null;
    while(!input && Date.now()<end){
      input = await findInputHandle();
      if(!input) await page.waitForTimeout(100);
    }
    if(!input){ log("INPUT not found"); return false; }

    // escribir rápido (sin borrar nada)
    await humanType(input, text, "fast");

    // si la plataforma lo “come”, cerrar aviso y re-escribir más lento (sin borrar)
    let val = await getInputValue(input);
    if (val.length < Math.min(90, Math.floor(text.length*0.5))){
      log("Anti-paste? retype slow");
      await closeCopyWarning();
      await humanType(input, text, "slow");
      val = await getInputValue(input);
    }

    // enviar
    const btn = page.locator(SELECTORS.sendButton).first();
    if (await btn.count()){
      try{ await btn.click({timeout:900}); }
      catch{ await btn.click({timeout:900,force:true}); }
    } else {
      await page.keyboard.press("Enter");
    }
    log("SEND pressed");

    // verificar publicación; si falla, reintentar una vez (sin borrar)
    let ok = await waitPosted(text, 7000);
    if (!ok){
      log("Not posted; retry ultra-slow");
      await closeCopyWarning();
      await humanType(input, " ", "slow"); // “rompe” heurística de duplicado sin borrar
      await humanType(input, text, "slow");
      if (await btn.count()){ try{ await btn.click({timeout:900}); }catch{ await btn.click({timeout:900,force:true}); } }
      else { await page.keyboard.press("Enter"); }
      ok = await waitPosted(text, 8000);
    }
    return ok;
  }catch(e){
    if(String(e).includes("has been closed")){
      log("Recovered after closed page");
      try{ await context?.close(); }catch{}
      try{ await browser?.close(); }catch{}
      browser=context=page=null;
      return false;
    }
    log("sendMessage error:", e.message||e);
    return false;
  }
}

// ---------- Bucle ----------
async function loginIfNeeded(){
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await acceptCookiesAnywhere(page);
  await dismissOnboardingWizard(page);

  if (await isLoginForm()) await performLogin();
  await page.waitForTimeout(350);

  await dismissOnboardingWizard(page);
  await acceptCookiesAnywhere(page);
}

async function loop(){
  await ensureBrowser();
  await loginIfNeeded();

  while(true){
    try{
      if(!running){ await page.waitForTimeout(500); continue; }
      if (await isLoginForm()) { await performLogin(); await page.waitForTimeout(500); continue; }

      await acceptCookiesAnywhere(page);
      await dismissOnboardingWizard(page);

      if (await tryStartChatting()){ await page.waitForTimeout(400); continue; }
      if (await isQueueVisible()){ await page.waitForTimeout(1200); continue; }

      const { chat, perfil } = await getContextText();
      if(!chat || chat.length<10){ await page.waitForTimeout(500); continue; }

      let reply = await generateReply(chat, perfil);
      reply = sanitizeEs(reply);
      reply = ensureMinLength(reply);

      const ok = await sendMessage(reply);
      if (!ok) log("send failed, next loop");

      // pausa corta para no agotar tiempo de turno
      await page.waitForTimeout(600 + Math.floor(Math.random()*400));
    }catch(e){
      log("Loop error:", e?.message||e);
      if(String(e).includes("has been closed")){
        try{ await context?.close(); }catch{}
        try{ await browser?.close(); }catch{}
        browser=context=page=null;
        await ensureBrowser();
        await loginIfNeeded();
      }else{
        await page.waitForTimeout(500);
      }
    }
  }
}

// ---------- HTTP control ----------
function checkToken(req,res,next){
  if(req.query.token!==CONTROL_TOKEN) return res.status(401).send("unauthorized");
  next();
}
app.get("/",(_,res)=>res.send("OK"));
app.get("/health",(_,res)=>res.json({running}));
app.post("/pause",checkToken,(_,res)=>{running=false;res.json({running});});
app.post("/resume",checkToken,(_,res)=>{running=true;res.json({running});});
app.get("/screenshot",checkToken,async(_,res)=>{ if(!page) return res.status(500).send("page not ready"); const buf=await page.screenshot({fullPage:true}); res.setHeader("Content-Type","image/png"); res.send(buf); });
app.get("/html",checkToken,async(_,res)=>{ if(!page) return res.status(500).send("page not ready"); res.setHeader("Content-Type","text/plain; charset=utf-8"); res.send(await page.content()); });

const port = process.env.PORT || 3000;
app.listen(port, ()=>{
  log("Server listening on", port);
  (async function run(){ try{ await loop(); } catch(e){ log("Top-level error:", e); setTimeout(run, 1500); } })();
});

// utils
function rand(a,b){ return Math.floor(Math.random()*(b-a+1))+a; }
