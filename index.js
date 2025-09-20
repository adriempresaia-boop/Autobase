// index.js — Autobase CJS (no borra nunca, no usa panel YOU ARE)
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

const MIN_CHARS = Number(MIN_CHARS_ENV || 170);  // >=150 por norma
const CHAT_LAST_LINES = 8;                       // solo últimos mensajes

let browser, context, page;
let running = true;

const app = express();
app.use(express.json());
const log = (...a)=>console.log(new Date().toISOString(), ...a);

// fetch compatible
const fetchFn = globalThis.fetch
  ? (...a)=>globalThis.fetch(...a)
  : (...a)=>import("node-fetch").then(({default:f})=>f(...a));

// --------- utilidades UI ----------
async function ensureBrowser(){
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
  const texts=[/aceptar/i,/aceptar todas/i,/ok/i,/entendido/i,/close/i,/agree|accept/i];
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
  return {
    chat:(chatText||"").split("\n").slice(-CHAT_LAST_LINES).join("\n")
  };
}

// ---------- Generación solo con chat ----------
const BANNED = ["celular","vos ","qué rico","recién","ahorita","computadora","cachetadas","jalar","platicar","carro","papi","lechita"," coger "];
const REPLACEMENTS = [
  [/computadora/gi,"ordenador"],
  [/celular/gi,"móvil"],
  [/platicar/gi,"charlar"],
  [/carro/gi,"coche"],
  [/ahorita/gi,"ahora"],
  [/vos(?:otros)?/gi,"tú"],
  [/\s+coger\s+/gi," tener "],
];

function sanitizeEs(text){
  let out=(text||"").trim();
  for (const [re,rep] of REPLACEMENTS) out = out.replace(re,rep);
  for (const w of BANNED) out = out.replace(new RegExp(w,"gi"),"");
  out = out.replace(/[*_#>`~\[\]\(\)]/g,"").replace(/\s{2,}/g," ").trim();
  if (!/[?¿]\s*$/.test(out)) { out = out.replace(/[.!…]*\s*$/, ""); out += " ¿Tú qué dirías?"; }
  return out;
}
function ensureMinLength(text){
  const fillers = [
    " Me gusta llevarlo con naturalidad y picardía, sin prisas.",
    " Si te parece, seguimos por ahí y lo hilamos con calma.",
    " Me encanta escucharte y jugar con esa chispa, a nuestro ritmo."
  ];
  let out=sanitizeEs(text);
  while(out.length<MIN_CHARS){
    out += " " + fillers[(out.length/33|0)%fillers.length];
    if (!/[?¿]\s*$/.test(out)) out += " ¿Te cuadra?";
  }
  return out;
}
function buildPrompt(chat){
  return `
Escribe UNA sola respuesta en español de España, cercana y coqueta pero sin cruzar líneas. Prohibido insultos, proponer quedar, datos personales o contenido explícito. 180-230 caracteres aprox. Termina con una pregunta abierta. Evita latam (celular, vos, qué rico, recién, ahorita, computadora, jalar, platicar, carro, papi, lechita, "coger" sexual).

Últimos mensajes (usa SOLO esto):
${chat || "No disponible"}
`.trim();
}

const lastMessages = [];
const LAST_N = 12;

async function generateReply(chat){
  async function local(){
    const last = (chat||"").split("\n").slice(-5).join(" ").trim();
    let s = last ? `Te leo y me quedo con esto: ${last}. ` : "";
    s += "Soy natural y juguetona; me gusta la conversación con elegancia y chispa. ";
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
          {role:"system",content:"Responde en español de España. Nada de quedar, ni insultos, ni datos, ni explícito."},
          {role:"user",content:buildPrompt(chat)}
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

// ---------- Entrada y envío (sin borrar y sin reescribir) ----------
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

function rand(a,b){ return Math.floor(Math.random()*(b-a+1))+a; }
async function humanType(h, text, mode="fast"){
  const perChar = mode==="slow" ? [65,110] : [33,70];
  const pauseWord = mode==="slow" ? [160,300] : [80,160];
  const pausePunct= mode==="slow" ? [300,620] : [180,360];

  await h.focus();
  const tokens = text.split(/(\s+)/);
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

async function clickSendNearInput(input) {
  try{
    const el = await input.elementHandle();
    const clicked = await page.evaluate((n)=>{
      function visible(e){ const s=getComputedStyle(e); return s && s.visibility!=='hidden' && s.display!=='none' && e.offsetParent!==null; }
      const root = n.closest('form') || n.closest('div') || document;
      const btns = [...root.querySelectorAll('button,[role="button"],.btn,.v-btn')];
      for(const b of btns){
        const t=(b.innerText||"").toLowerCase();
        const svg=(b.querySelector("svg")||{}).outerHTML||"";
        if(!visible(b)) continue;
        if(/enviar|send|submit/.test(t) || /plane/.test(svg) || b.type==="submit"){ b.click(); return true; }
      }
      return false;
    }, el);
    if (clicked) return true;
  }catch{}
  return false;
}

async function waitPostedOrCleared(input, text, timeoutMs=6500){
  const beforeChat = await page.evaluate(sel => (document.querySelector(sel)?.innerText)||"", SELECTORS.chatArea);
  const snippet = (text||"").slice(0,45).replace(/\s+/g," ").trim();
  const end = Date.now()+timeoutMs;
  while(Date.now()<end){
    const nowChat = await page.evaluate(sel => (document.querySelector(sel)?.innerText)||"", SELECTORS.chatArea);
    const val = await getInputValue(input);
    if (!val || val.trim()==="") return true;                 // se vació el cuadro
    if (nowChat.length>beforeChat.length && nowChat.includes(snippet)) return true; // apareció en chat
    await page.waitForTimeout(220);
  }
  return false;
}

async function sendMessage(text){
  try{
    // localizar input
    const end=Date.now()+7000;
    let input=null;
    while(!input && Date.now()<end){
      input = await findInputHandle();
      if(!input) await page.waitForTimeout(100);
    }
    if(!input){ log("INPUT not found"); return false; }

    // si ya está escrito (de reintentos previos), NO volver a escribir
    let current = await getInputValue(input);
    const already = current && (current.length >= Math.min(text.length*0.6, 120));
    if (!already){
      // escribir una sola vez (rápido)
      await humanType(input, text, "fast");
      await page.waitForTimeout(120);
      current = await getInputValue(input);
      if (current.length < Math.min(90, Math.floor(text.length*0.5))){
        // el sitio “se comió” texto: cerrar aviso y escribir MÁS LENTO (sin borrar)
        log("Anti-paste? retype slow");
        await closeCopyWarning();
        await humanType(input, text, "slow");
        current = await getInputValue(input);
      }
    }

    // enviar: botón cerca del input -> Enter -> Ctrl+Enter
    let clicked = await clickSendNearInput(input);
    if (!clicked){
      try{ await input.focus(); await page.keyboard.press("Enter"); }catch{}
    }
    await page.waitForTimeout(250);
    if (!clicked){
      try{
        await input.focus();
        await page.keyboard.down("Control");
        await page.keyboard.press("Enter");
        await page.keyboard.up("Control");
      }catch{}
    }
    log("SEND pressed");

    // verificar; no reescribe en ningún caso
    let ok = await waitPostedOrCleared(input, text, 7500);
    if (!ok){
      log("Not posted; retry press only");
      // solo re-intentar la acción de enviar, sin tocar el texto
      clicked = await clickSendNearInput(input);
      if (!clicked){ try{ await input.focus(); await page.keyboard.press("Enter"); }catch{} }
      await page.waitForTimeout(250);
      if (!clicked){
        try{
          await input.focus();
          await page.keyboard.down("Control");
          await page.keyboard.press("Enter");
          await page.keyboard.up("Control");
        }catch{}
      }
      ok = await waitPostedOrCleared(input, text, 8000);
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

// ---------- Login + bucle ----------
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

      const { chat } = await getContextText();
      if(!chat || chat.length<10){ await page.waitForTimeout(500); continue; }

      let reply = await generateReply(chat);
      reply = ensureMinLength(reply); // español y longitud

      const ok = await sendMessage(reply);
      if (!ok) log("send failed, next loop");

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
