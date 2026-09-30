'use strict';
const D = id => document.getElementById(id);
let csrf = localStorage.getItem("oacv_csrf") || "";
let user = null;
let lib = [];
let libTimer = null;
let live = null;          /* dernier état de l'antenne */
let liveAt = 0;           /* quand on l'a reçu, pour faire avancer la barre */

async function api(path, opts){
  opts = opts || {};
  const h = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
  if (csrf) h["X-CSRF-Token"] = csrf;
  const r = await fetch(path, Object.assign({}, opts, { headers: h, credentials: "same-origin" }));
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("json") ? await r.json() : null;
  if (!r.ok){
    if (r.status === 401){ showLogin(); throw new Error("connexion requise"); }
    throw new Error((data && data.error) || ("erreur " + r.status));
  }
  return data;
}

function showLogin(){ D("login-card").classList.remove("hidden"); D("dash").classList.add("hidden"); D("logout").classList.add("hidden"); }
function showDash(){ D("login-card").classList.add("hidden"); D("dash").classList.remove("hidden"); D("logout").classList.remove("hidden"); }

/* Ouvre le tableau de bord et branche les trois rafraichissements :
   l'état du studio, la banque de titres, et l'antenne en direct. */
let ticking = null;
function startDash(){
  showDash();
  refresh(); loadLib(); pollLive();
  if (ticking) return;
  ticking = setInterval(refresh, 3000);
  setInterval(pollLive, 3000);
  setInterval(paintLive, 1000);
}

D("login-form").addEventListener("submit", async e => {
  e.preventDefault();
  D("lg-err").textContent = "";
  try {
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ email: D("lg-email").value.trim(), password: D("lg-pass").value }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "connexion refusée");
    csrf = j.csrf || csrf;
    if (csrf) localStorage.setItem("oacv_csrf", csrf);
    user = j.user;
    startDash();
  } catch(err){ D("lg-err").textContent = err.message; }
});

D("logout").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST" }); } catch(e){}
  localStorage.removeItem("oacv_csrf");
  showLogin();
});

const mmss = s => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };

/* ---- Radio en direct : on affiche le même morceau que le site public ---- */
async function pollLive(){
  let j = null;
  try {
    const r = await fetch("/api/radio/now", { cache: "no-store" });
    if (r.ok){ const d = await r.json(); if (d && d.live) j = d; }
  } catch(e){}
  if (j){
    live = j;
    liveAt = Date.now();
    D("live-art").src = j.thumb;
    D("live-title").textContent = j.title || j.videoId;
    D("live-author").textContent = j.author || "Playlist OACV";
    D("live-next").textContent = j.next ? ("Ensuite : " + (j.next.title || j.next.videoId) + (j.next.author ? " — " + j.next.author : "")) : "";
    D("live-state").textContent = j.paused
      ? "Antenne interrompue — le morceau est gelé."
      : "En cours sur radio-oacv — c'est ce que toute l'antenne entend.";
  } else {
    D("live-state").textContent = "Antenne indisponible : le site public tourne sur sa propre rotation.";
  }
  paintLive();
}

/* La barre avance toute seule entre deux appels, sinon elle clignoterait
   toutes les 3 secondes. */
function paintLive(){
  if (!live) return;
  const el = live.paused ? live.elapsed : live.elapsed + Math.floor((Date.now() - liveAt) / 1000);
  const cur = Math.min(el, live.duration);
  D("live-bar").style.width = (live.duration ? (cur / live.duration) * 100 : 0) + "%";
  D("live-time").textContent = mmss(cur) + " / " + mmss(live.duration);
}

async function refresh(){
  let st;
  try { st = await api("/api/studio/state"); } catch(e){ return; }
  const inter = st.interrupt && st.interrupt.active;
  const b = D("st-inter");
  if (inter){
    b.textContent = "ANTENNE INTERROMPUE — jingle diffusé, rotation en pause";
    b.classList.remove("hidden");
    D("it-now").classList.add("hidden"); D("it-after").classList.add("hidden");
    D("it-resume").classList.remove("hidden");
  } else {
    b.classList.add("hidden");
    D("it-now").classList.remove("hidden"); D("it-after").classList.remove("hidden");
    D("it-resume").classList.add("hidden");
  }
  const nx = st.playNext;
  D("st-next").textContent = nx ? ("Prochain morceau : " + (nx.title || nx.videoId) + (nx.author ? " — " + nx.author : "")) : "Aucun morceau programmé — rotation aléatoire.";
  D("nx-clear").classList.toggle("hidden", !nx);
}

async function act(path, body){
  try { await api(path, { method: "POST", body: JSON.stringify(body || {}) }); refresh(); }
  catch(e){ console.warn(e.message); }
}
D("it-now").addEventListener("click", () => act("/api/studio/interrupt", { when: "now" }));
D("it-after").addEventListener("click", () => act("/api/studio/interrupt", { when: "after" }));
D("it-resume").addEventListener("click", () => act("/api/studio/resume"));
D("nx-clear").addEventListener("click", () => act("/api/studio/next", {}));

async function loadLib(){
  try {
    const j = await api("/api/library/music?limit=2000");
    lib = j.items || [];
    D("lib-info").textContent = j.counts ? (j.counts.total + " titres dans la banque") : (lib.length + " titres");
    render();
  } catch(e){ D("lib-info").textContent = "Bibliothèque indisponible : " + e.message; }
}

function render(){
  const q = D("q").value.trim().toLowerCase();
  const list = (q ? lib.filter(v => (v.title + " " + (v.author || "")).toLowerCase().includes(q)) : lib).slice(0, 60);
  const ul = D("results");
  ul.textContent = "";
  for (const v of list){
    const li = document.createElement("li");
    const img = document.createElement("img");
    img.src = "https://i.ytimg.com/vi/" + v.id + "/mqdefault.jpg";
    img.alt = "";
    const t = document.createElement("div"); t.className = "t";
    const b = document.createElement("b"); b.textContent = v.title || v.id;
    const i = document.createElement("i"); i.textContent = v.author || "";
    t.appendChild(b); t.appendChild(i);
    const bNow = document.createElement("button");
    bNow.textContent = "▶ Lire";
    bNow.title = "Lire tout de suite";
    bNow.addEventListener("click", () => act("/api/studio/play-now", { videoId: v.id, title: v.title }));
    const bNext = document.createElement("button");
    bNext.textContent = "Ensuite";
    bNext.title = "À la fin du morceau en cours";
    bNext.addEventListener("click", () => act("/api/studio/next", { videoId: v.id, title: v.title, author: v.author }));
    li.appendChild(img); li.appendChild(t); li.appendChild(bNow); li.appendChild(bNext);
    ul.appendChild(li);
  }
  if (!list.length) D("lib-info").textContent = "aucun résultat";
}

D("q").addEventListener("input", () => { clearTimeout(libTimer); libTimer = setTimeout(render, 150); });

(async function boot(){
  try {
    const me = await fetch("/api/me", { credentials: "same-origin" }).then(r => r.json());
    if (me.user){
      csrf = me.csrf || csrf; user = me.user;
      startDash();
      return;
    }
  } catch(e){}
  showLogin();
})();