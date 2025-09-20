// index.js — Autobase (CommonJS) — Playwright + Express
require("dotenv").config();
const express = require("express");
const { chromium } = require("playwright");

// ===================== CONFIG =====================
const {
  EMAIL,
  PASSWORD,
  OPENAI_API_KEY,
  MODEL = "gpt-4o-mini",
  BASE_URL = "https://chathomebase.com/login",
  CONTROL_TOKEN = "change_me",
  MIN_CHARS: MIN_CHARS_ENV
} = process.env;

const MIN_CHARS = Number(MIN_CHARS_ENV || 180); // mínimo con margen
const CHAT_LAST_LINES = 14;                      // ~4–5 mensajes
const TYPE_RANGE_FAST = [12, 35];               // tecleo humano por carácter
const TYPE_RANGE_PAUSE = [90, 260];             // pausas humanas
const HUMAN_ERR_PROB = 0.02;                    // pequeñas correcciones

let browser, context, page;
let running = true;
const app = express();
app.use(express.json());

const log = (...a) => console.log(new Date().toISOString(), ...a);
const fetchFn = globalThis.fetch ? (...a) => globalThis.fetch(...a)
  : (...a) => import("node-fetch").then(({default: f}) => f(...a));

const BANNED = [
  "celular","vos ","qué rico","recién","ahorita","computadora",
  "cachetadas","jalar","platicar","carro","papi","lechita","coger "
];
const lastMessages = [];
const LAST_N = 12;

const SELECTORS = {
  chatArea: "main, div[role='main'], div[data-testid='chat']",
  inputCandidates: [
    "textarea",
    "div[contenteditable='true']",
    "[role='textbox']",
    "textarea[placeholder*='message' i]",
    "textarea[placeholder*='mensaje' i]",
    "textarea[placeholder*='escribe' i]",
    "textarea[placeholder*='type your reply here' i]",
    "input[name*='message' i]",
    "div[data-testid*='input' i]",
    "div[data-placeholder*='mensaje' i]",
    "div[data-placeholder*='message' i]"
  ],
  sendButton:
    "button:has-text('Send'), [aria-label='Send'], [data-testid='send'], button:has-text('Enviar')"
};

// ===================== UTILS =====================
const rand = (min,max)=> Math.floor(Math.random()*(max-min+1))+min;

async function acceptCookiesAnywhere(p){
  const texts = [/accept all/i,/accept/i,/agree/i,/allow all/i,/aceptar todas/i,/aceptar/i,/entendido/i,/ok/i];
  for (const t of texts) {
    try {
      const b = p.getByRole("button",{ name: t });
      if (await b.count() && await b.first().isVisible({ timeout: 300 })) {
        await b.first().click({ timeout: 1500 });
        await p.waitForTimeout(100);
      }
    } catch {}
  }
}
async function nukeOverlays(p){
  try {
    await p.evaluate(() => {
      const kill = [
        "[data-testid='claimedNotification']",".chat-claimed-notification",
        ".toast",".Toastify",".v-snack",".v-toast",".noty_bar",".notification"
      ];
      kill.forEach(sel=>document.querySelectorAll(sel).forEach(el=>{
        try{ el.style.display="none"; el.remove?.(); }catch{}
      }));
    });
  } catch {}
}
async function wizardVisible(p){
  try {
    return await p.getByText(/información importante sobre expresiones/i).first()
      .isVisible({ timeout: 200 });
  } catch { return false; }
}
async function clickByTextEverywhere(p, regexes){
  return await p.evaluate((labels)=>{
    const match=(el,re)=>el && re.test((el.innerText||el.textContent||"").trim());
    const clickables=[...document.querySelectorAll('button,[role="button"],.v-btn,.btn')];
    for(const el of clickables){
      for(const re of labels){
        if(match(el,re) && el.offsetParent!==null){
          try{ el.click(); return true; }catch{}
        }
      }
    }
    const modals=[...document.querySelectorAll('[role="dialog"], .v-dialog, .modal')];
    for(const m of modals){
      const btns=[...m.querySelectorAll('button,[role="button"],.v-btn,.btn')];
      for(const el of btns){
        for(const re of labels){
          if(match(el,re) && el.offsetParent!==null){
            try{ el.click(); return true; }catch{}
          }
        }
      }
    }
    return false;
  }, regexes);
}
async function dismissOnboardingWizard(p){
  for(let i=0;i<20;i++){
    await acceptCookiesAnywhere(p);
    let clicked=false;
    try { clicked = await clickByTextEverywhere(p,[/^next$/i,/siguiente/i,/cerrar/i,/close/i,/entendido/i,/ok/i,/finalizar/i]); } catch {}
    if(!clicked){ try{ await p.keyboard.press("Enter"); }catch{} await p.waitForTimeout(80); }
    if(!(await wizardVisible(p))) return true;
  }
  // plan B: quitar modal por script
  try{
    await p.evaluate(()=>{
      const sel=/información importante sobre expresiones/i;
      const dlg=[...document.querySelectorAll('[role="dialog"], .v-dialog, .modal')]
        .find(d=>sel.test(d.innerText||""));
      if(dlg){ dlg.style.display="none"; dlg.remove?.(); }
    });
  }catch{}
  return false;
}

async function ensureBrowser(){
  if (browser && !browser.isConnected?.()) { try{await browser.close();}catch{} browser=null; }
  if(!browser){
    browser = await chromium.launch({
      headless:true,
      args:[
        "--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage",
        "--disable-gpu","--no-zygote","--single-process",
        "--renderer-process-limit=1","--js-flags=--max-old-space-size=256"
      ]
    });
  }
  if(!context){
    context = await browser.newContext({
      viewport:{width:1366,height:900},
      locale:"es-ES", timezoneId:"Europe/Madrid",
      userAgent:"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
    });
  }
  if(!page || page.isClosed()) page = await context.newPage();
}
async function ensureLivePage(){
  await ensureBrowser();
  if (!page || page.isClosed()){
    page = await context.newPage();
    await loginIfNeeded();
  }
}

// ===================== LOGIN =====================
const emailSel = 'input[type="email"], input[placeholder="Email"], input[placeholder*="email" i], input[name="email"]';
const passSel  = 'input[type="password"], input[placeholder="Password"], input[placeholder*="password" i], input[name*="pass" i]';
const signSel  = 'button:has-text("SIGN IN"), button:has-text("Sign in"), button:has-text("Login"), button:has-text("Entrar"), button[type="submit"]';

async function isLoginForm(){
  try { return (await page.locator(emailSel).count()) && (await page.locator(passSel).count()); } catch { return false; }
}
async function waitUntilEnabled(locator, timeout=5000){
  const t0=Date.now();
  while(Date.now()-t0<timeout){
    try{ if(!(await locator.isDisabled())) return true; }catch{}
    await page.waitForTimeout(80);
  }
  return false;
}
async function performLogin(){
  const e=page.locator(emailSel).first();
  const p=page.locator(passSel).first();
  try{ await e.waitFor({state:"visible",timeout:4000}); await p.waitFor({state:"visible",timeout:4000}); }catch{}
  try{ await e.click({timeout:1500}); await e.fill(""); await e.type(EMAIL,{delay:18}); }catch{}
  try{ await p.click({timeout:1500}); await p.fill(""); await p.type(PASSWORD,{delay:18}); }catch{}
  const btn=page.locator(signSel).first();
  await waitUntilEnabled(btn,4000);
  try{ await btn.click({timeout:1500}); }catch{ try{ await p.press("Enter"); }catch{} }
  await page.waitForTimeout(600);
}

// ===================== QUEUE / CLAIM =====================
async function isQueueVisible(){
  const a = await page.getByText(/Waiting for conversation to be claimed/i).first().isVisible().catch(()=>false);
  const b = await page.getByRole("button",{ name:/start chatting|start chat|start/i }).first().isVisible().catch(()=>false);
  const c = await page.evaluate(()=>/START CHATTING|Waiting for conversation to be claimed/i.test(document.body.innerText||"")).catch(()=>false);
  return a||b||c;
}
async function tryStartChatting(){
  await nukeOverlays(page);
  const locs = [
    page.getByRole("button",{ name:/start chatting|start chat|start/i }),
    page.getByText(/^START CHATTING$/i),
    page.locator("[data-testid='start-chatting'], [data-test='start-chatting']")
  ];
  for(const l of locs){
    try{
      const el=l.first(); if(!(await el.count())) continue;
      await el.scrollIntoViewIfNeeded().catch(()=>{});
      try{ await el.click({timeout:600}); return true; }catch{}
      try{ await el.click({timeout:600,force:true}); return true; }catch{}
      try{ const h=await el.elementHandle(); await page.evaluate(n=>n&&n.click(),h); return true; }catch{}
      try{ await el.focus(); await page.keyboard.press("Enter"); return true; }catch{}
    }catch{}
  }
  return false;
}

// ===================== CONTEXTO + RESPUESTA =====================
async function extractText(sel){ return page.evaluate(s => (document.querySelector(s)?.innerText)||"", sel); }

async function getContextText(){
  const chatText = await extractText(SELECTORS.chatArea);
  let perfil = "";
  try {
    perfil = await page.evaluate(() => {
      const node=[...document.querySelectorAll("*")].find(n=>/YOU ARE/i.test(n.innerText||""));
      const box=node?.closest("aside")||node?.parentElement;
      return box? box.innerText : (node?.innerText||"");
    });
  } catch {}
  return {
    chat:(chatText||"").split("\n").slice(-CHAT_LAST_LINES).join("\n"),
    perfil
  };
}
function ensureMinLength(text){
  const fillers=[
    " Me apetece seguir con buen rollo y calma, así nos vamos conociendo mejor.",
    " Si te apetece, dime por dónde seguimos y lo hacemos a nuestro ritmo con esa chispa."
  ];
  let out=(text||"").trim();
  if(!/[?¿]\s*$/.test(out)){ out = out.replace(/[.!…]*\s*$/, ""); out += " ¿Tú qué opinas?"; }
  let i=0;
  while(out.length<MIN_CHARS){
    out += fillers[i++%fillers.length];
    if(!/[?¿]\s*$/.test(out)) out += " ¿Seguimos por ahí?";
  }
  return out;
}
function localCompose({chat,perfil}){
  const last = (chat||"").split("\n").slice(-8).join(" ").trim();
  let s = last ? `Sobre lo último que me dices: ${last}. ` : "";
  s += "Soy cercana y natural; me gusta flirtear con elegancia sin cruzar líneas. ";
  s += "¿Qué te apetece ahora, seguimos por donde lo dejamos y me cuentas un poco más?";
  s = s.replace(/\b(celular|vos |qué rico|recién|ahorita|computadora|cachetadas|jalar|platicar|carro|papi|lechita|coger )\b/gi,"");
  return ensureMinLength(s);
}
function buildPrompt({chat,perfil}){
  return `
Escribe UNA respuesta en español de España (tono humano, coqueto y natural, sin tacos ni proponer quedar ni datos). 
Usa lo ÚLTIMO de la conversación; 200–260 caracteres aprox. Termina con pregunta abierta. 
Evita: celular, vos, qué rico, recién, ahorita, computadora, cachetadas, jalar, platicar, carro, papi, lechita, "coger" (sexual).

Personaje (panel "YOU ARE"):
${perfil || "No disponible"}

Últimos mensajes:
${chat || "No disponible"}
`.trim();
}
function uniqueTweak(text){
  const tails = [
    " Me tienes con una sonrisa.",
    " Me intriga cómo lo cuentas.",
    " Me encanta esa energía.",
    " Me dejas con ganas de más.",
    " Me gusta ese toque tuyo."
  ];
  return text + " " + tails[rand(0,tails.length-1)];
}
async function generateReply(chat, perfil){
  if(!OPENAI_API_KEY){
    let t = localCompose({chat,perfil});
    if(lastMessages.includes(t)) t = uniqueTweak(t);
    lastMessages.push(t); while(lastMessages.length>LAST_N) lastMessages.shift();
    return t;
  }
  try{
    const body = { model: MODEL, temperature: 0.95, messages:[
      { role:"system", content:"Español de España; estilo humano; cumple normas; no quedadas." },
      { role:"user", content: buildPrompt({chat,perfil}) }
    ]};
    const r = await fetchFn("https://api.openai.com/v1/chat/completions",{
      method:"POST",
      headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,"Content-Type":"application/json"},
      body:JSON.stringify(body)
    });
    if(!r.ok) throw new Error("OpenAI "+r.status);
    const data=await r.json();
    let text=data?.choices?.[0]?.message?.content?.trim()||"";
    if(!text) throw new Error("empty");
    if (BANNED.some(w=>text.toLowerCase().includes(w))) text = localCompose({chat,perfil});
    text = ensureMinLength(text);
    if(lastMessages.includes(text)) text = uniqueTweak(text);
    lastMessages.push(text); while(lastMessages.length>LAST_N) lastMessages.shift();
    log("GEN OK len=",text.length);
    return text;
  }catch(e){
    let fb = localCompose({chat,perfil});
    if(lastMessages.includes(fb)) fb=uniqueTweak(fb);
    lastMessages.push(fb); while(lastMessages.length>LAST_N) lastMessages.shift();
    log("GEN fallback len=",fb.length);
    return fb;
  }
}

// ===================== INPUT + TECLADO HUMANO =====================
async function findInputHandle(){
  await nukeOverlays(page);
  for(const sel of SELECTORS.inputCandidates){
    try{
      const h = page.locator(sel).last();
      if(await h.count()){
        if(await h.isVisible({timeout:250})) return h;
      }
    }catch{}
  }
  return null;
}
async function getInputValue(h){
  try{
    const el = await h.elementHandle();
    return await page.evaluate(n=>{
      if(!n) return "";
      if(n.tagName==="TEXTAREA" || (n.tagName==="INPUT" && n.type==="text")) return n.value || "";
      if(n.getAttribute("contenteditable")==="true") return n.innerText || "";
      return n.textContent || "";
    },el);
  }catch{ return ""; }
}

/** Tecleo humano rápido, con mini-pausas y pequeñas correcciones */
async function humanType(h, text){
  await h.focus();
  for (const ch of text){
    // 2% de “error” y backspace
    if (Math.random() < HUMAN_ERR_PROB){
      const wrong = String.fromCharCode(97 + Math.floor(Math.random()*26));
      try { await page.keyboard.type(wrong, { delay: rand(...TYPE_RANGE_FAST) }); } catch {}
      try { await page.keyboard.press("Backspace"); } catch {}
    }
    try { await page.keyboard.type(ch, { delay: rand(...TYPE_RANGE_FAST) }); } catch {}
    if (Math.random() < 0.08) await page.waitForTimeout(rand(...TYPE_RANGE_PAUSE));
  }
}

async function sendMessage(text){
  try{
    await ensureLivePage();
    await dismissOnboardingWizard(page);
    await nukeOverlays(page);

    // localizar input (8s como máx)
    const input = await (async()=>{
      const end=Date.now()+8000;
      while(Date.now()<end){
        const h=await findInputHandle();
        if(h) return h;
        await page.waitForTimeout(120);
      }
      return null;
    })();
    if(!input){ log("INPUT not found"); return false; }

    // Limpieza previa ligera (sin borrar después)
    try{ await input.click({ timeout:1200, force:true }); }catch{}
    try{ await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control"); await page.keyboard.press("Backspace"); }catch{}
    try{ await input.click({ clickCount:3 }); await page.keyboard.press("Backspace"); }catch{}

    // Escribir con estilo humano
    await humanType(input, text);

    // ¿el sitio ha “vaciado” el campo (anti-paste)?
    let val = await getInputValue(input);
    if (val.length < Math.min(60, Math.floor(text.length*0.4))){
      // reintentar más despacio
      log("Anti-paste detected; retyping slower");
      try{ await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control"); await page.keyboard.press("Backspace"); }catch{}
      await page.waitForTimeout(200);
      await humanType(input, text);
      val = await getInputValue(input);
    }

    // Enviar
    await nukeOverlays(page);
    const btn = page.locator(SELECTORS.sendButton).first();
    if (await btn.count()){
      try { await btn.click({ timeout: 1200 }); }
      catch { await btn.click({ timeout: 1200, force:true }); }
    } else {
      await page.keyboard.press("Enter");
    }
    log("SEND pressed");
    return true;
  }catch(e){
    if(String(e).includes("has been closed")){
      try{ await context?.close(); }catch{}
      try{ await browser?.close(); }catch{}
      browser=context=page=null;
      log("Recovered after closed page; will retry next loop");
      return false;
    }
    log("sendMessage error:", e.message||e);
    return false;
  }
}

// ===================== LOOP =====================
async function loginIfNeeded(){
  await page.goto(BASE_URL, { waitUntil:"domcontentloaded" });
  await acceptCookiesAnywhere(page);
  await dismissOnboardingWizard(page);
  await nukeOverlays(page);

  if(await isQueueVisible()) return;
  if(await isLoginForm()) await performLogin();

  await page.waitForLoadState("domcontentloaded").catch(()=>{});
  await dismissOnboardingWizard(page);
  await nukeOverlays(page);
  await page.waitForTimeout(250);
}
async function loop(){
  await ensureBrowser();
  await loginIfNeeded();

  while(true){
    try{
      if(!running){ await page.waitForTimeout(700); continue; }

      if(await isLoginForm()){ await performLogin(); await page.waitForTimeout(700); continue; }

      await dismissOnboardingWizard(page);
      await nukeOverlays(page);

      if(await tryStartChatting()){ await page.waitForTimeout(700); continue; }
      if(await isQueueVisible()){ await page.waitForTimeout(1800); continue; }

      const { chat, perfil } = await getContextText();
      if(!chat || chat.length<10){ await page.waitForTimeout(700); continue; }

      const reply = await generateReply(chat, perfil);
      await sendMessage(reply);

      // ciclo corto (hay tiempo límite)
      await page.waitForTimeout(900 + Math.floor(Math.random()*600));
    }catch(e){
      log("Loop error:", e?.message||e);
      if(String(e).includes("has been closed")){
        try{ await context?.close(); }catch{}
        try{ await browser?.close(); }catch{}
        browser=context=page=null;
        await ensureBrowser();
        await loginIfNeeded();
      }else{
        await page.waitForTimeout(600);
      }
    }
  }
}

// ===================== CONTROL =====================
function checkToken(req,res,next){
  if(req.query.token!==CONTROL_TOKEN) return res.status(401).send("unauthorized");
  next();
}
app.get("/", (_,res)=>res.send("OK"));
app.get("/health", (_,res)=>res.json({ running }));
app.post("/pause", checkToken, (_,res)=>{ running=false; res.json({ running }); });
app.post("/resume", checkToken, (_,res)=>{ running=true; res.json({ running }); });
app.get("/screenshot", checkToken, async (_,res)=>{ if(!page) return res.status(500).send("page not ready"); const buf=await page.screenshot({fullPage:true}); res.setHeader("Content-Type","image/png"); res.send(buf); });
app.get("/html", checkToken, async (_,res)=>{ if(!page) return res.status(500).send("page not ready"); res.setHeader("Content-Type","text/plain; charset=utf-8"); res.send(await page.content()); });

const port = process.env.PORT || 3000;
app.listen(port, ()=>{
  log("Server listening on", port);
  (async function run(){ try{ await loop(); } catch(e){ log("Top-level error:", e); setTimeout(run, 2000); } })();
});
