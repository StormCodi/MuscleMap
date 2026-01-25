import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { classifyMeshName } from "./lib/muscleMap.js";

const API_CHAT = "./api/ai_chat.php";
const API_ADD_EX = "./api/add_exercises.php";

const chatLog = document.getElementById("chatLog");
const composer = document.getElementById("composer");
const msgInput = document.getElementById("msgInput");
const imgInput = document.getElementById("imgInput");
const sendBtn = document.getElementById("sendBtn");
const clearBtn = document.getElementById("clearBtn");
const statusLine = document.getElementById("statusLine");

const previewMount = document.getElementById("preview");
const previewTitle = document.getElementById("previewTitle");
const previewSub = document.getElementById("previewSub");
const jsonOut = document.getElementById("jsonOut");

const LS_KEY = "musclemap_ai_chat_v2";
const MAX_HISTORY = 40;     // sent to server
const MAX_RENDER = 120;     // keep DOM from ballooning

let history = loadHistory();

/* =========================
   Helpers
========================= */
function esc(s){
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function nowTime(){
  const d = new Date();
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}

function setStatus(s){
  statusLine.textContent = s || "";
}

function loadHistory(){
  try {
    const raw = localStorage.getItem(LS_KEY);
    const data = JSON.parse(raw || "null");
    if (Array.isArray(data)) return data;
  } catch {}
  return [];
}

function saveHistory(){
  try { localStorage.setItem(LS_KEY, JSON.stringify(history.slice(-MAX_HISTORY))); } catch {}
}

function clearHistory(){
  history = [];
  try { localStorage.removeItem(LS_KEY); } catch {}
  chatLog.innerHTML = "";
  jsonOut.textContent = "{}";
  previewTitle.textContent = "No proposal yet";
  previewSub.textContent = "When AI proposes an exercise, muscles will highlight here.";
  applyPreviewWeights(null);
}

function trimRender(){
  // prevent UI from degrading over time
  const nodes = chatLog.querySelectorAll(".bubble");
  if (nodes.length <= MAX_RENDER) return;
  const removeCount = nodes.length - MAX_RENDER;
  for (let i = 0; i < removeCount; i++) nodes[i].remove();
}

function addBubble({role, text, imageUrl, extraHtml}){
  const el = document.createElement("div");
  el.className = `bubble ${role === "user" ? "user" : "ai"}`;
  const who = role === "user" ? "You" : "AI";

  el.innerHTML = `
    <div class="meta">${esc(who)} • ${esc(nowTime())}</div>
    <div class="text">${text ? esc(text) : `<span style="opacity:.65">(no text)</span>`}</div>
    ${imageUrl ? `<img src="${imageUrl}" alt="upload" style="max-width:100%; border-radius:10px; margin-top:8px; border:1px solid rgba(255,255,255,.08)" />` : ``}
    ${extraHtml || ""}
  `;

  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  trimRender();
  return el;
}

function makeTypingBubble(){
  const el = document.createElement("div");
  el.className = "bubble ai";
  el.innerHTML = `
    <div class="meta">AI • ${esc(nowTime())}</div>
    <div class="text" id="typingText">thinking…</div>
  `;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  trimRender();
  return {
    el,
    set(s){ const t = el.querySelector("#typingText"); if (t) t.textContent = s; },
    remove(){ el.remove(); }
  };
}

/* =========================
   3D Preview
========================= */
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(previewMount.clientWidth, previewMount.clientHeight);
renderer.setClearColor(0x0b0b0c, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
previewMount.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, previewMount.clientWidth/previewMount.clientHeight, 0.01, 5000);
camera.position.set(0, 160, 380);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 120, 0);

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
scene.add(new THREE.HemisphereLight(0xffffff, 0x202020, 0.55));
const dir = new THREE.DirectionalLight(0xffffff, 1.0);
dir.position.set(250, 450, 250);
scene.add(dir);

const grid = new THREE.GridHelper(800, 40, 0x2a2a2a, 0x181818);
grid.position.y = 0;
scene.add(grid);

let currentModel = null;
const gymMeshes = [];

function makeBaselineMat(){
  return new THREE.MeshStandardMaterial({
    color: 0x7a7a7a,
    roughness: 0.88,
    metalness: 0.0,
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 0.0,
  });
}
function makeSkinMat(){
  return new THREE.MeshStandardMaterial({
    color: 0x8e8e94,
    roughness: 0.95,
    metalness: 0.0,
    transparent: true,
    opacity: 0.32,
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 0.0,
    depthWrite: false,
  });
}
function frameObject(obj){
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  controls.target.copy(center);

  const maxDim = Math.max(size.x, size.y, size.z);
  const dist = maxDim * 1.25;
  camera.position.set(center.x, center.y + maxDim * 0.15, center.z + dist);
  camera.near = Math.max(0.01, maxDim / 1000);
  camera.far = maxDim * 20;
  camera.updateProjectionMatrix();
}
function clearModel(){
  if (currentModel) scene.remove(currentModel);
  currentModel = null;
  gymMeshes.length = 0;
}
async function loadPreviewGLB(){
  const loader = new GLTFLoader();
  const candidates = ["./assets/models/body.glb","./assets/models/body.draco.glb"];

  for (const url of candidates){
    try{
      const gltf = await new Promise((resolve,reject)=>loader.load(url, resolve, undefined, reject));
      clearModel();

      currentModel = gltf.scene;
      const skinMat = makeSkinMat();

      currentModel.traverse((obj)=>{
        if (!obj.isMesh) return;
        const info = classifyMeshName(obj.name);

        if (info.kind === "shell"){
          obj.material = skinMat;
          obj.visible = true;
          obj.renderOrder = 2;
          return;
        }
        if (info.kind === "gym"){
          obj.visible = true;
          obj.renderOrder = 1;
          const base = makeBaselineMat();
          obj.material = base;
          obj.userData._groups = info.groups || [];
          gymMeshes.push(obj);
          return;
        }
        obj.visible = false;
      });

      scene.add(currentModel);
      frameObject(currentModel);
      return;
    } catch(e){
      console.warn("[ai preview] failed", url, e?.message || e);
    }
  }
}

function clamp01(x){ return Math.max(0, Math.min(1, x)); }

function applyPreviewWeights(weights){
  const w = (weights && typeof weights === "object") ? weights : null;

  for (const mesh of gymMeshes){
    const groups = mesh.userData?._groups || [];
    let max = 0;
    for (const g of groups){
      const v = w && Number.isFinite(w[g]) ? w[g] : 0;
      if (v > max) max = v;
    }
    const h = clamp01(max);

    let emissive = new THREE.Color(0x000000);
    let eI = 0.0;
    if (h > 0.05){
      emissive = (h < 0.35) ? new THREE.Color(0x3cff7a)
              : (h < 0.65) ? new THREE.Color(0xffd84d)
                           : new THREE.Color(0xff9b3c);
      eI = 0.9;
    }
    mesh.material.color = new THREE.Color(0x7a7a7a);
    mesh.material.emissive = emissive;
    mesh.material.emissiveIntensity = eI;
  }
}

window.addEventListener("resize", ()=>{
  renderer.setSize(previewMount.clientWidth, previewMount.clientHeight);
  camera.aspect = previewMount.clientWidth / previewMount.clientHeight;
  camera.updateProjectionMatrix();
});

function animate(){
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
loadPreviewGLB();
animate();

/* =========================
   Reply cards
========================= */
function renderReplyCard(reply){
  const type = reply?.type || "error";

  if (type === "error"){
    return `<div class="card"><b>Error</b><div class="text">${esc(reply.text || "Unknown error")}</div></div>`;
  }

  if (type === "question"){
    const choices = Array.isArray(reply.choices) ? reply.choices : [];
    const btns = choices.map((c)=>`<button class="btn secondary" type="button" data-quick="${esc(c)}">${esc(c)}</button>`).join("");
    return `
      <div class="card">
        <b>Question</b>
        <div class="text">${esc(reply.text || "")}</div>
        ${choices.length ? `<div class="btnrow">${btns}</div>` : ``}
      </div>
    `;
  }

  if (type === "exists"){
    return `
      <div class="card">
        <b>Exists</b>
        <div class="text">${esc(reply.name || reply.id || "")}</div>
        <div style="opacity:.75; font-size:12px;">Exact match: <code>${esc(reply.id || "")}</code></div>
      </div>
    `;
  }

  if (type === "propose_add"){
    const p = reply.proposal || {};
    const weights = p.weights || {};
    const weightsLines = Object.entries(weights)
      .sort((a,b)=> (b[1]||0)-(a[1]||0))
      .map(([k,v])=> `${k}: ${Number(v).toFixed(2)}`)
      .join("\n");

    return `
      <div class="card">
        <b>Proposed new exercise</b>
        <div class="text">${esc(p.name || "")}</div>
        <div style="opacity:.75; font-size:12px;">
          Key: <code>${esc(p.exercise_key || "")}</code> • confidence: ${(Number(p.confidence||0)*100).toFixed(0)}%
        </div>
        <div style="margin-top:8px;">
          <div style="opacity:.75; font-size:12px;">Weights</div>
          <pre class="jsonBox">${esc(weightsLines || "(none)")}</pre>
        </div>
        <div class="btnrow">
          <button class="btn" type="button" data-accept="1">Accept & add</button>
          <button class="btn secondary" type="button" data-reject="1">Reject</button>
        </div>
      </div>
    `;
  }

  return `<div class="card"><b>Unknown</b><pre class="jsonBox">${esc(JSON.stringify(reply, null, 2))}</pre></div>`;
}

/* =========================
   Server calls
========================= */
async function sendToServer({ text, imageFile }, typing){
  const fd = new FormData();
  fd.append("payload", JSON.stringify({
    history: history.slice(-MAX_HISTORY),
    text: text || ""
  }));
  if (imageFile) fd.append("image", imageFile, imageFile.name || "image.jpg");

  typing?.set(imageFile ? "Uploading image…" : "Sending…");

  const res = await fetch(API_CHAT, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    body: fd
  });

  typing?.set("Waiting for AI…");

  const raw = await res.text();
  let json;
  try { json = JSON.parse(raw); }
  catch { throw new Error(`Server returned non-JSON:\n${raw.slice(0, 800)}`); }

  if (!res.ok || json?.ok === false) throw new Error(json?.error || `HTTP ${res.status}`);
  return json;
}

async function acceptProposal(p){
  const res = await fetch(API_ADD_EX, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({
      id: p.exercise_key,
      name: p.name,
      w: p.weights,
      source: "ai"
    })
  });

  const raw = await res.text();
  let json;
  try { json = JSON.parse(raw); }
  catch { throw new Error(`Non-JSON add_exercises:\n${raw.slice(0, 800)}`); }

  if (!res.ok || json?.ok === false) throw new Error(json?.error || `HTTP ${res.status}`);
  return true;
}

/* =========================
   Init render
========================= */
function renderHistory(){
  chatLog.innerHTML = "";
  for (const m of history){
    addBubble({ role: m.role, text: m.text || "" });
  }
}
renderHistory();

/* =========================
   Events
========================= */
clearBtn.addEventListener("click", ()=>{
  if (!confirm("Clear AI chat history?")) return;
  clearHistory();
  setStatus("");
});

composer.addEventListener("submit", async (ev)=>{
  ev.preventDefault();

  const text = (msgInput.value || "").trim();
  const file = imgInput?.files?.[0] || null;

  if (!text && !file) return;

  // show user bubble immediately
  const imgUrl = file ? URL.createObjectURL(file) : null;
  addBubble({ role:"user", text: text || "(image)", imageUrl: imgUrl });

  // store *text-only* history so it doesn’t bloat + break UI
  history.push({ role:"user", text: text || "(image)" });
  history = history.slice(-MAX_HISTORY);
  saveHistory();

  msgInput.value = "";
  imgInput.value = "";

  sendBtn.disabled = true;
  const typing = makeTypingBubble();
  setStatus("Running…");

  try{
    const replyJson = await sendToServer({ text, imageFile: file }, typing);

    typing.remove();

    const assistant = replyJson.assistant || {};
    const reply = assistant.reply || { type:"error", text:"Missing reply." };

    // update history from server (still text-only)
    if (Array.isArray(replyJson.history)) {
      history = replyJson.history.slice(-MAX_HISTORY);
      saveHistory();
    }

    jsonOut.textContent = JSON.stringify(assistant.raw_json || reply, null, 2);

    const extra = renderReplyCard(reply);
    const aiEl = addBubble({ role:"assistant", text: assistant.text || "", extraHtml: extra });

    // preview
    if (reply.type === "propose_add" && reply.proposal?.weights) {
      previewTitle.textContent = reply.proposal.name || "Proposal";
      previewSub.textContent = `Key: ${reply.proposal.exercise_key || ""}`;
      applyPreviewWeights(reply.proposal.weights);
    } else {
      previewTitle.textContent = "No proposal yet";
      previewSub.textContent = "When AI proposes an exercise, muscles will highlight here.";
      applyPreviewWeights(null);
    }

    // quick replies
    aiEl.querySelectorAll("[data-quick]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        msgInput.value = btn.getAttribute("data-quick") || "";
        msgInput.focus();
      });
    });

    const acceptBtn = aiEl.querySelector("[data-accept]");
    if (acceptBtn && reply.type === "propose_add") {
      acceptBtn.addEventListener("click", async ()=>{
        acceptBtn.disabled = true;
        setStatus("Adding to database…");
        try{
          await acceptProposal(reply.proposal);
          addBubble({ role:"assistant", text:`Added: ${reply.proposal.name} (${reply.proposal.exercise_key})` });
          setStatus("Added.");
        } catch(e){
          addBubble({ role:"assistant", text:`Failed to add: ${String(e?.message || e)}` });
          acceptBtn.disabled = false;
          setStatus("");
        }
      });
    }

    const rejectBtn = aiEl.querySelector("[data-reject]");
    if (rejectBtn) {
      rejectBtn.addEventListener("click", ()=>{
        addBubble({ role:"assistant", text:"Okay — rejected." });
        previewTitle.textContent = "No proposal yet";
        previewSub.textContent = "When AI proposes an exercise, muscles will highlight here.";
        applyPreviewWeights(null);
      });
    }

    setStatus("");
  } catch(e){
    typing.remove();
    addBubble({ role:"assistant", text:`Error: ${String(e?.message || e)}` });
    setStatus("");
  } finally{
    sendBtn.disabled = false;
  }
});
