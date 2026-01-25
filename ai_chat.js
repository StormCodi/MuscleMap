import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { classifyMeshName, GROUPS } from "./lib/muscleMap.js";

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

const LS_KEY = "musclemap_ai_chat_v1";

// We keep full history client-side and send it to server each time.
let history = loadHistory();

/* =========================
   Chat UI helpers
========================= */
function esc(s){
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function nowTime(){
  const d = new Date();
  const hh = String(d.getHours()).padStart(2,"0");
  const mm = String(d.getMinutes()).padStart(2,"0");
  return `${hh}:${mm}`;
}

function setStatus(s){
  statusLine.textContent = s || "";
}

function makeTypingBubble(){
  const el = document.createElement("div");
  el.className = "bubble ai";
  el.dataset.typing = "1";
  el.innerHTML = `
    <div class="meta">AI • ${esc(nowTime())}</div>
    <div class="text">
      <span class="typing">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </span>
      <span class="small" style="margin-left:8px;">thinking…</span>
    </div>
  `;
  return el;
}

function addBubble({role, text, imageDataUrl, extraHtml}){
  const el = document.createElement("div");
  el.className = `bubble ${role === "user" ? "user" : "ai"}`;

  const who = role === "user" ? "You" : "AI";
  el.innerHTML = `
    <div class="meta">${esc(who)} • ${esc(nowTime())}</div>
    ${text ? `<div class="text">${esc(text)}</div>` : `<div class="text muted2">(no text)</div>`}
    ${imageDataUrl ? `<img src="${imageDataUrl}" alt="upload" />` : ``}
    ${extraHtml || ""}
  `;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
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
  try { localStorage.setItem(LS_KEY, JSON.stringify(history)); } catch {}
}

function clearHistory(){
  history = [];
  saveHistory();
  chatLog.innerHTML = "";
  jsonOut.textContent = "{}";
  previewTitle.textContent = "No proposal yet";
  previewSub.textContent = "When AI proposes an exercise, muscles will highlight here.";
  applyPreviewWeights(null);
}

/* =========================
   3D Preview (highlight muscles from proposal weights)
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
const pickables = [];

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
function clearModel(){
  if (currentModel) scene.remove(currentModel);
  currentModel = null;
  gymMeshes.length = 0;
  pickables.length = 0;
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

async function loadPreviewGLB(){
  const loader = new GLTFLoader();

  const candidates = [
    "./assets/models/body.glb",
    "./assets/models/body.draco.glb",
  ];

  for (const url of candidates){
    try {
      const gltf = await new Promise((resolve, reject) => {
        loader.load(url, resolve, undefined, reject);
      });

      clearModel();
      currentModel = gltf.scene;
      currentModel.scale.setScalar(1);
      currentModel.position.set(0,0,0);

      const skinMat = makeSkinMat();
      currentModel.traverse((obj) => {
        if (!obj.isMesh) return;
        const info = classifyMeshName(obj.name);

        if (info.kind === "shell"){
          obj.material = skinMat;
          obj.renderOrder = 2;
          obj.visible = true;
          return;
        }

        if (info.kind === "gym"){
          obj.visible = true;
          obj.renderOrder = 1;
          const base = makeBaselineMat();
          obj.material = base;
          obj.userData._muscle = { groups: info.groups || [], baseMaterial: base };
          gymMeshes.push({ mesh: obj, groups: obj.userData._muscle.groups });
          pickables.push(obj);
          return;
        }

        obj.visible = false;
      });

      scene.add(currentModel);
      frameObject(currentModel);
      return;
    } catch (e) {
      console.warn("[preview] failed", url, e?.message || e);
    }
  }
  console.warn("[preview] No model found (body.glb). Preview will remain blank.");
}

function clamp01(x){ return Math.max(0, Math.min(1, x)); }

function applyPreviewWeights(weights){
  // weights: { groupId: float } or null
  const w = weights && typeof weights === "object" ? weights : null;

  for (const { mesh, groups } of gymMeshes){
    let max = 0;
    for (const g of groups){
      const v = w && Number.isFinite(w[g]) ? w[g] : 0;
      if (v > max) max = v;
    }

    const h = clamp01(max);

    // Visual scale:
    // baseline gray -> green/yellow/orange as intensity rises
    let color = new THREE.Color(0x7a7a7a);
    let emissive = new THREE.Color(0x000000);
    let eI = 0.0;

    if (h > 0.05){
      emissive = (h < 0.35) ? new THREE.Color(0x3cff7a)
              : (h < 0.65) ? new THREE.Color(0xffd84d)
                           : new THREE.Color(0xff9b3c);
      eI = 0.9;
    }

    mesh.material.color = color;
    mesh.material.emissive = emissive;
    mesh.material.emissiveIntensity = eI;
    mesh.material.wireframe = false;
  }
}

window.addEventListener("resize", () => {
  renderer.setSize(previewMount.clientWidth, previewMount.clientHeight);
  camera.aspect = previewMount.clientWidth / previewMount.clientHeight;
  camera.updateProjectionMatrix();
});

let lastAnim = performance.now();
function animate(){
  requestAnimationFrame(animate);
  const now = performance.now();
  if (now - lastAnim > 16) lastAnim = now;
  controls.update();
  renderer.render(scene, camera);
}
loadPreviewGLB();
animate();

/* =========================
   Rendering AI reply cards
========================= */
function renderReplyCard(reply){
  // reply: normalized object from server
  const type = reply?.type || "error";

  if (type === "error"){
    return `<div class="card"><b>Error</b><div class="text">${esc(reply.text || "Unknown error")}</div></div>`;
  }

  if (type === "question"){
    const choices = Array.isArray(reply.choices) ? reply.choices : [];
    const btns = choices.map((c) => {
      const safe = esc(c);
      return `<button class="btn secondary" type="button" data-quick="${safe}">${safe}</button>`;
    }).join("");
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
        <div class="small">Exact match found: <code>${esc(reply.id || "")}</code></div>
      </div>
    `;
  }

  if (type === "propose_add"){
    const p = reply.proposal || {};
    const weights = p.weights || {};
    const weightsLines = Object.entries(weights)
      .sort((a,b) => (b[1]||0) - (a[1]||0))
      .map(([k,v]) => `${k}: ${Number(v).toFixed(2)}`)
      .join("\n");

    return `
      <div class="card">
        <b>Proposed new exercise</b>
        <div class="text">${esc(p.name || "")}</div>
        <div class="small">Key: <code>${esc(p.exercise_key || "")}</code> • confidence: ${(Number(p.confidence||0)*100).toFixed(0)}%</div>

        <div style="margin-top:8px;">
          <div class="small">Weights</div>
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
   Server call
========================= */
async function sendToServer({ text, imageFile }) {
  // status updates so it never feels frozen
  setStatus("Preparing…");

  // attach image as data URL on server side (multipart)
  const fd = new FormData();
  const payload = {
    // send full history so model "remembers everything"
    history: history.slice(-40), // keep last 40 messages max
    text: text || ""
  };
  fd.append("payload", JSON.stringify(payload));
  if (imageFile) fd.append("image", imageFile, imageFile.name || "image.jpg");

  setStatus(imageFile ? "Uploading image…" : "Sending message…");

  const res = await fetch(API_CHAT, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    body: fd
  });

  setStatus("Waiting for AI…");

  const raw = await res.text();
  let json;
  try { json = JSON.parse(raw); }
  catch { throw new Error(`Server returned non-JSON:\n${raw.slice(0, 800)}`); }

  if (!res.ok || json?.ok === false) {
    throw new Error(json?.error || `HTTP ${res.status}`);
  }

  return json;
}

/* =========================
   Accept proposal
========================= */
async function acceptProposal(p){
  const res = await fetch(API_ADD_EX, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
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
   Event wiring
========================= */
function renderHistory(){
  chatLog.innerHTML = "";
  for (const m of history){
    addBubble({
      role: m.role,
      text: m.text || "",
      imageDataUrl: m.image_b64 || null
    });
  }
}

renderHistory();

clearBtn.addEventListener("click", () => {
  if (!confirm("Clear AI chat history?")) return;
  clearHistory();
});

composer.addEventListener("submit", async (ev) => {
  ev.preventDefault();

  const text = (msgInput.value || "").trim();
  const file = imgInput.files && imgInput.files[0] ? imgInput.files[0] : null;

  if (!text && !file) return;

  // UI: show your message immediately
  const userMsg = { role:"user", text, image_b64: null };
  history.push(userMsg);
  saveHistory();

  addBubble({ role:"user", text });

  // Clear composer inputs
  msgInput.value = "";
  imgInput.value = "";

  // UI: typing indicator bubble
  const typingEl = makeTypingBubble();
  chatLog.appendChild(typingEl);
  chatLog.scrollTop = chatLog.scrollHeight;

  sendBtn.disabled = true;

  try {
    const replyJson = await sendToServer({ text, imageFile: file });

    // server returns:
    // { ok:true, assistant:{ role:"assistant", text:"...", reply:{...}, raw_json:{...} }, history:[...] }
    const assistant = replyJson.assistant || {};
    const reply = assistant.reply || { type:"error", text:"Missing reply." };

    // update stored history from server (includes the image data URL if server added it)
    if (Array.isArray(replyJson.history)) {
      history = replyJson.history;
      saveHistory();
    }

    // remove typing bubble
    typingEl.remove();

    // dump last raw json
    jsonOut.textContent = JSON.stringify(assistant.raw_json || reply, null, 2);

    // render AI bubble with card UI
    const extra = renderReplyCard(reply);
    const aiEl = addBubble({
      role:"assistant",
      text: assistant.text || "",
      extraHtml: extra
    });

    // Apply preview if propose_add
    if (reply.type === "propose_add" && reply.proposal?.weights) {
      previewTitle.textContent = reply.proposal.name || "Proposal";
      previewSub.textContent = `Key: ${reply.proposal.exercise_key || ""}`;
      applyPreviewWeights(reply.proposal.weights);
    } else {
      applyPreviewWeights(null);
      previewTitle.textContent = "No proposal yet";
      previewSub.textContent = "When AI proposes an exercise, muscles will highlight here.";
    }

    // wire quick-choice buttons and accept/reject
    aiEl.querySelectorAll("[data-quick]").forEach(btn => {
      btn.addEventListener("click", () => {
        const txt = btn.getAttribute("data-quick") || "";
        msgInput.value = txt;
        msgInput.focus();
      });
    });

    const acceptBtn = aiEl.querySelector("[data-accept]");
    if (acceptBtn && reply.type === "propose_add") {
      acceptBtn.addEventListener("click", async () => {
        acceptBtn.disabled = true;
        setStatus("Adding to database…");
        try {
          await acceptProposal(reply.proposal);

          // add a local AI confirmation bubble
          addBubble({
            role:"assistant",
            text:`Added: ${reply.proposal.name} (${reply.proposal.exercise_key})`
          });

          setStatus("Added. You can go back to MuscleMap.");
        } catch (e) {
          addBubble({ role:"assistant", text:`Failed to add: ${String(e?.message || e)}` });
          setStatus("");
          acceptBtn.disabled = false;
        }
      });
    }

    const rejectBtn = aiEl.querySelector("[data-reject]");
    if (rejectBtn) {
      rejectBtn.addEventListener("click", () => {
        addBubble({ role:"assistant", text:"Okay — rejected." });
        applyPreviewWeights(null);
        previewTitle.textContent = "No proposal yet";
        previewSub.textContent = "When AI proposes an exercise, muscles will highlight here.";
      });
    }

    setStatus("");
  } catch (e) {
    typingEl.remove();
    addBubble({ role:"assistant", text:`Error: ${String(e?.message || e)}` });
    setStatus("");
  } finally {
    sendBtn.disabled = false;
  }
});
