import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { classifyMeshName } from "./lib/muscleMap.js";

const API_CHAT   = "./api/ai_chat.php";
const API_ADD_EX = "./api/add_exercises.php";
const API_UPLOAD = "./api/ai_upload.php";

const chatLog     = document.getElementById("chatLog");
const composer    = document.getElementById("composer");
const msgInput    = document.getElementById("msgInput");
const imgInput    = document.getElementById("imgInput");
const sendBtn     = document.getElementById("sendBtn");
const clearBtn    = document.getElementById("clearBtn");
const statusLine  = document.getElementById("statusLine");
const attachStrip = document.getElementById("attachStrip");

const previewMount = document.getElementById("preview");
const previewTitle = document.getElementById("previewTitle");
const previewSub   = document.getElementById("previewSub");
const jsonOut      = document.getElementById("jsonOut");

const LS_KEY = "musclemap_ai_chat_v2";

// history entries: {role, text, images?: [url,...]}
let history = loadHistory();

// attachments: { id, fileName, status:"uploading"|"ready"|"error", token, url, localPreview, err, aborter }
let attachments = [];

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
function setStatus(s){ statusLine.textContent = s || ""; }
function uid(){ return Math.random().toString(16).slice(2) + Date.now().toString(16); }

function hasPendingUploads(){ return attachments.some(a => a.status === "uploading"); }
function hasReadyAttachments(){ return attachments.some(a => a.status === "ready"); }

function updateSendEnabled(){
  // Send allowed if: no pending uploads AND (text OR at least one uploaded image)
  const text = (msgInput.value || "").trim();
  const canSend = !hasPendingUploads() && (text.length > 0 || hasReadyAttachments());
  sendBtn.disabled = !canSend;
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

function addBubble({role, text, images, extraHtml}){
  const el = document.createElement("div");
  el.className = `bubble ${role === "user" ? "user" : "ai"}`;

  const who = role === "user" ? "You" : "AI";
  const imgsHtml = Array.isArray(images) && images.length
    ? `<div class="imgRow">${images.map(u => `<img src="${esc(u)}" alt="upload" />`).join("")}</div>`
    : "";

  el.innerHTML = `
    <div class="meta">${esc(who)} • ${esc(nowTime())}</div>
    ${text ? `<div class="text">${esc(text)}</div>` : ``}
    ${imgsHtml}
    ${extraHtml || ""}
  `;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
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
      <span style="margin-left:8px; opacity:.75;">thinking…</span>
    </div>
  `;
  return el;
}

/* =========================
   Attachments UI
========================= */
function renderAttachments(){
  attachStrip.innerHTML = "";

  for (const a of attachments){
    const t = document.createElement("div");
    t.className = "thumb";
    t.dataset.aid = a.id;

    const imgSrc =
      a.localPreview ||
      a.url ||
      "data:image/svg+xml;base64," + btoa(
        `<svg xmlns="http://www.w3.org/2000/svg" width="54" height="54">
          <rect width="54" height="54" fill="#111"/>
          <text x="27" y="30" font-size="10" fill="#999" text-anchor="middle">upload</text>
        </svg>`
      );

    t.innerHTML = `
      <img src="${imgSrc}" alt="${esc(a.fileName || "image")}" />
      <button type="button" title="Remove">×</button>
    `;

    if (a.status === "uploading"){
      const ov = document.createElement("div");
      ov.style.position = "absolute";
      ov.style.inset = "0";
      ov.style.display = "flex";
      ov.style.alignItems = "center";
      ov.style.justifyContent = "center";
      ov.style.background = "rgba(0,0,0,0.35)";
      ov.innerHTML = `
        <div style="width:18px;height:18px;border-radius:999px;border:2px solid rgba(255,255,255,0.25);border-top-color:#fff;animation:spin 0.8s linear infinite;"></div>
      `;
      t.appendChild(ov);
    }

    if (a.status === "error"){
      const ov = document.createElement("div");
      ov.style.position = "absolute";
      ov.style.inset = "0";
      ov.style.display = "flex";
      ov.style.alignItems = "center";
      ov.style.justifyContent = "center";
      ov.style.background = "rgba(0,0,0,0.45)";
      ov.innerHTML = `<div style="font-size:11px;color:#ff8a8a;">fail</div>`;
      t.appendChild(ov);
    }

    t.querySelector("button").addEventListener("click", () => removeAttachment(a.id));
    attachStrip.appendChild(t);
  }

  updateSendEnabled();
}

function removeAttachment(id){
  const idx = attachments.findIndex(x => x.id === id);
  if (idx === -1) return;

  const a = attachments[idx];
  if (a.status === "uploading" && a.aborter){
    try { a.aborter.abort(); } catch {}
  }
  attachments.splice(idx, 1);
  renderAttachments();
}

function fileToDataUrl(file){
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("read_fail"));
    r.onload = () => resolve(String(r.result || ""));
    r.readAsDataURL(file);
  });
}

async function uploadOneImage(file, aborter){
  const fd = new FormData();
  fd.append("image", file, file.name || "image.jpg");

  const res = await fetch(API_UPLOAD, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    body: fd,
    signal: aborter.signal
  });

  const raw = await res.text();
  let json;
  try { json = JSON.parse(raw); }
  catch { throw new Error(`Upload non-JSON:\n${raw.slice(0, 500)}`); }

  if (!res.ok || json?.ok === false){
    throw new Error(json?.error || `HTTP ${res.status}`);
  }
  if (!json.token) throw new Error("upload_missing_token");
  if (!json.url) throw new Error("upload_missing_url");

  return { token: String(json.token), url: String(json.url) };
}

async function onPickImages(files){
  if (!files || !files.length) return;

  const picked = Array.from(files).slice(0, 6);
  for (const f of picked){
    const id = uid();
    const aborter = new AbortController();

    const item = {
      id,
      fileName: f.name || "image",
      status: "uploading",
      token: null,
      url: null,
      localPreview: null,
      err: null,
      aborter
    };
    attachments.push(item);

    // show local preview instantly
    try { item.localPreview = await fileToDataUrl(f); } catch {}
    renderAttachments();

    (async () => {
      try {
        setStatus("Uploading image…");
        const out = await uploadOneImage(f, aborter);

        const a = attachments.find(x => x.id === id);
        if (!a) return; // removed while uploading

        a.status = "ready";
        a.token = out.token;
        a.url = out.url;
        a.localPreview = null;

        setStatus("");
        renderAttachments();
      } catch (e) {
        const a = attachments.find(x => x.id === id);
        if (!a) return;

        if (aborter.signal.aborted){
          setStatus("");
          return;
        }

        a.status = "error";
        a.err = String(e?.message || e);
        setStatus("Upload failed");
        renderAttachments();
      } finally {
        updateSendEnabled();
      }
    })();
  }
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
function clearModel(){
  if (currentModel) scene.remove(currentModel);
  currentModel = null;
  gymMeshes.length = 0;
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
  const candidates = ["./assets/models/body.glb", "./assets/models/body.draco.glb"];

  for (const url of candidates){
    try {
      const gltf = await new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));

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
          return;
        }

        obj.visible = false;
      });

      scene.add(currentModel);
      frameObject(currentModel);
      return;
    } catch {}
  }
}
function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function applyPreviewWeights(weights){
  const w = weights && typeof weights === "object" ? weights : null;

  for (const { mesh, groups } of gymMeshes){
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

    mesh.material.emissive = emissive;
    mesh.material.emissiveIntensity = eI;
  }
}

window.addEventListener("resize", () => {
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

  const renderProposal = (p, idx) => {
    const weights = p.weights || {};
    const weightsLines = Object.entries(weights)
      .sort((a,b) => (b[1]||0) - (a[1]||0))
      .map(([k,v]) => `${k}: ${Number(v).toFixed(2)}`)
      .join("\n");

    return `
      <div class="card" data-proposal-card="1" data-proposal-idx="${idx}">
        <b>Proposed</b>
        <div class="text">${esc(p.name || "")}</div>
        <div class="small">Key: <code>${esc(p.exercise_key || "")}</code> • confidence: ${(Number(p.confidence||0)*100).toFixed(0)}%</div>

        <div style="margin-top:8px;">
          <div class="small">Weights</div>
          <pre class="jsonBox">${esc(weightsLines || "(none)")}</pre>
        </div>

        <div class="btnrow">
          <button class="btn" type="button" data-accept="1" data-idx="${idx}">Accept & add</button>
          <button class="btn secondary" type="button" data-preview="1" data-idx="${idx}">Preview</button>
          <button class="btn secondary" type="button" data-reject="1" data-idx="${idx}">Reject</button>
        </div>
      </div>
    `;
  };

  if (type === "propose_add"){
    return renderProposal(reply.proposal || {}, 0);
  }
  if (type === "propose_add_many"){
    const arr = Array.isArray(reply.proposals) ? reply.proposals : [];
    if (!arr.length) return `<div class="card"><b>Proposals</b><div class="text">(none)</div></div>`;
    return `<div class="card"><b>Multiple proposals</b><div class="small">You can accept each one independently.</div></div>`
      + arr.map((p, i) => renderProposal(p, i)).join("");
  }

  return `<div class="card"><b>Unknown</b><pre class="jsonBox">${esc(JSON.stringify(reply, null, 2))}</pre></div>`;
}

/* =========================
   Server calls
========================= */
async function sendToServer({ text, imageTokens }) {
  setStatus("Sending…");

  const payload = {
    history: history.slice(-40),
    text: text || "",
    image_tokens: Array.isArray(imageTokens) ? imageTokens : []
  };

  const res = await fetch(API_CHAT, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const raw = await res.text();
  let json;
  try { json = JSON.parse(raw); }
  catch { throw new Error(`Server returned non-JSON:\n${raw.slice(0, 800)}`); }

  if (!res.ok || json?.ok === false) {
    throw new Error(json?.error || `HTTP ${res.status}`);
  }
  return json;
}

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
   Render history
========================= */
function renderHistory(){
  chatLog.innerHTML = "";
  for (const m of history){
    addBubble({
      role: m.role,
      text: m.text || "",
      images: Array.isArray(m.images) ? m.images : []
    });
  }
}
renderHistory();

/* =========================
   Events
========================= */
clearBtn.addEventListener("click", () => {
  if (!confirm("Clear AI chat history?")) return;
  clearHistory();
});

msgInput.addEventListener("input", updateSendEnabled);

imgInput.addEventListener("change", async () => {
  const files = imgInput.files ? Array.from(imgInput.files) : [];
  imgInput.value = "";
  await onPickImages(files);
  updateSendEnabled();
});

composer.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (hasPendingUploads()) return;

  const text = (msgInput.value || "").trim();
  const ready = attachments.filter(a => a.status === "ready" && a.token && a.url);

  const tokens = ready.map(a => a.token);
  const urls   = ready.map(a => a.url);

  // IMPORTANT: image NOT required — text-only allowed
  if (!text && tokens.length === 0) return;

  history.push({ role:"user", text, images: urls });
  saveHistory();
  addBubble({ role:"user", text, images: urls });

  msgInput.value = "";
  attachments = [];
  renderAttachments();

  const typingEl = makeTypingBubble();
  chatLog.appendChild(typingEl);
  chatLog.scrollTop = chatLog.scrollHeight;

  sendBtn.disabled = true;

  try {
    setStatus("Waiting for AI…");
    const replyJson = await sendToServer({ text, imageTokens: tokens });

    const assistant = replyJson.assistant || {};
    const reply = assistant.reply || { type:"error", text:"Missing reply." };

    typingEl.remove();

    jsonOut.textContent = JSON.stringify(assistant.raw_json || reply, null, 2);

    const extra = renderReplyCard(reply);
    const aiEl = addBubble({
      role:"assistant",
      text: assistant.text || "",
      extraHtml: extra
    });

    history.push({ role:"assistant", text: assistant.text || "" });
    saveHistory();

    // default preview
    if (reply.type === "propose_add" && reply.proposal?.weights){
      previewTitle.textContent = reply.proposal.name || "Proposal";
      previewSub.textContent = `Key: ${reply.proposal.exercise_key || ""}`;
      applyPreviewWeights(reply.proposal.weights);
    } else if (reply.type === "propose_add_many" && Array.isArray(reply.proposals) && reply.proposals[0]?.weights){
      previewTitle.textContent = reply.proposals[0].name || "Proposal";
      previewSub.textContent = `Key: ${reply.proposals[0].exercise_key || ""}`;
      applyPreviewWeights(reply.proposals[0].weights);
    } else {
      applyPreviewWeights(null);
      previewTitle.textContent = "No proposal yet";
      previewSub.textContent = "When AI proposes an exercise, muscles will highlight here.";
    }

    // quick replies
    aiEl.querySelectorAll("[data-quick]").forEach(btn => {
      btn.addEventListener("click", () => {
        const txt = btn.getAttribute("data-quick") || "";
        msgInput.value = txt;
        msgInput.focus();
        updateSendEnabled();
      });
    });

    // preview per proposal
    aiEl.querySelectorAll("[data-preview]").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-idx") || "0");
        const p = (reply.type === "propose_add_many")
          ? (reply.proposals?.[idx] || null)
          : (reply.proposal || null);

        if (p?.weights){
          previewTitle.textContent = p.name || "Proposal";
          previewSub.textContent = `Key: ${p.exercise_key || ""}`;
          applyPreviewWeights(p.weights);
        }
      });
    });

    // accept per proposal
    aiEl.querySelectorAll("[data-accept]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const idx = Number(btn.getAttribute("data-idx") || "0");
        const p = (reply.type === "propose_add_many")
          ? (reply.proposals?.[idx] || null)
          : (reply.proposal || null);

        if (!p) return;

        btn.disabled = true;
        setStatus("Adding to database…");
        try {
          await acceptProposal(p);
          addBubble({ role:"assistant", text:`Added: ${p.name} (${p.exercise_key})` });
          history.push({ role:"assistant", text:`Added: ${p.name} (${p.exercise_key})` });
          saveHistory();
          setStatus("Added.");
        } catch (e) {
          addBubble({ role:"assistant", text:`Failed to add: ${String(e?.message || e)}` });
          history.push({ role:"assistant", text:`Failed to add: ${String(e?.message || e)}` });
          saveHistory();
          setStatus("");
          btn.disabled = false;
        }
      });
    });

    // reject per proposal
    aiEl.querySelectorAll("[data-reject]").forEach(btn => {
      btn.addEventListener("click", () => {
        btn.disabled = true;
        addBubble({ role:"assistant", text:"Okay — rejected." });
        history.push({ role:"assistant", text:"Okay — rejected." });
        saveHistory();
      });
    });

    setStatus("");
  } catch (e) {
    typingEl.remove();
    addBubble({ role:"assistant", text:`Error: ${String(e?.message || e)}` });
    history.push({ role:"assistant", text:`Error: ${String(e?.message || e)}` });
    saveHistory();
    setStatus("");
  } finally {
    updateSendEnabled();
  }
});

renderAttachments();
updateSendEnabled();
