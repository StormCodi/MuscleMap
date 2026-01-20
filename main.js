// main.js
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import { EXERCISES, getExerciseById } from "./lib/exercises.js";
import { classifyMeshName } from "./lib/muscleMap.js";
import { tickDecay, applyStimulus, computeHeat, ensureMuscle } from "./lib/recovery.js";
import { generateRecs } from "./lib/recs.js";

/* ==============================
   PHP API endpoints
============================== */
const API_STATE_GET    = "./api/get_muscle_state.php";
const API_LOGS_GET     = "./api/get_logs.php";
const API_WORKOUT_LOG  = "./api/log_workout.php";
const API_STATE_RESET  = "./api/state_reset.php";


/* ----------------------------- DOM refs ----------------------------- */
const mount = document.getElementById("view");
if (!mount) throw new Error("Missing #view element");

const logForm = document.getElementById("logForm");
const dateInput = document.getElementById("dateInput");
const exerciseSelect = document.getElementById("exerciseSelect");
const setsInput = document.getElementById("setsInput");
const repsInput = document.getElementById("repsInput");
const loadInput = document.getElementById("loadInput");

const selectedBox = document.getElementById("selectedBox");
const recsBox = document.getElementById("recsBox");
const recsBtn = document.getElementById("recsBtn");
const resetBtn = document.getElementById("resetBtn");
const logsBox = document.getElementById("logsBox");

/* ----------------------------- State ----------------------------- */
let state = {
  logs: [],
  muscle: {},     // { groupId: { load, lastTrained, lastPing } }
  lastUpdate: Date.now(),
};

/* ----------------------------- API helpers ----------------------------- */
async function apiJson(url, opts = {}) {
  const res = await fetch(url, {
    cache: "no-store",
    credentials: "same-origin",
    ...opts,
    headers: {
      ...(opts.headers || {}),
      "Content-Type": "application/json",
    },
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`API ${url} returned non-JSON:\n${text.slice(0, 500)}`);
  }

  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error || `HTTP ${res.status} from ${url}`);
  }
  return data;
}

async function loadMuscleStateServer() {
  const data = await apiJson(API_STATE_GET, { method: "GET" });
  // expected: { ok:true, rows:[...] }
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const muscle = {};

  for (const r of rows) {
    const gid = String(r.muscle_group || "").trim();
    if (!gid) continue;

    muscle[gid] = {
      load: Number(r.load_value || 0),
      lastTrained: Number(r.last_trained_at || 0) * 1000, // php returns unix seconds
      lastPing: Number(r.last_ping_at || 0) * 1000,
    };
  }

  state.muscle = muscle;
  state.lastUpdate = Date.now();
}

async function loadLogsServer() {
  const data = await apiJson(API_LOGS_GET, { method: "GET" });
  // expected: { ok:true, rows:[...] }
  const rows = Array.isArray(data.rows) ? data.rows : [];

  // normalize to match your renderLogs()
  state.logs = rows.map((r) => ({
    id: String(r.id),
    date: String(r.workout_date),
    exerciseId: String(r.exercise_id),
    exerciseName: String(r.exercise_name),
    sets: Number(r.sets),
    reps: Number(r.reps),
    loadLbs: r.load_lbs === null || r.load_lbs === undefined ? null : Number(r.load_lbs),
    stimulus: Number(r.stimulus),
  }));

  state.lastUpdate = Date.now();
}

/* ----------------------------- Three.js setup ----------------------------- */
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(mount.clientWidth, mount.clientHeight);
renderer.setClearColor(0x0b0b0c, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
mount.appendChild(renderer.domElement);

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  45,
  mount.clientWidth / mount.clientHeight,
  0.01,
  5000
);
camera.position.set(0, 160, 380);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 120, 0);

// lights
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
scene.add(new THREE.HemisphereLight(0xffffff, 0x202020, 0.55));
const dir = new THREE.DirectionalLight(0xffffff, 1.0);
dir.position.set(250, 450, 250);
scene.add(dir);

// grid
const grid = new THREE.GridHelper(800, 40, 0x2a2a2a, 0x181818);
grid.position.y = 0;
scene.add(grid);

/* ----------------------------- Model bookkeeping ----------------------------- */
let currentModel = null;
const skinShellMeshes = [];
const gymMeshes = [];
const pickables = [];
let selectedMesh = null;

/* ----------------------------- Materials ----------------------------- */
function makeBaselineMuscleMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0x7a7a7a,
    roughness: 0.88,
    metalness: 0.0,
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 0.0,
  });
}

function makeSkinMaterial() {
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

function applySelectionLook(mesh) {
  if (!mesh?.material) return;
  mesh.material.emissive = new THREE.Color(0x18a944);
  mesh.material.emissiveIntensity = 1.15;
  mesh.material.color = new THREE.Color(0x3cff7a);
  mesh.material.wireframe = true;
  mesh.material.needsUpdate = true;
}

function clearSelectionLook(mesh) {
  if (!mesh?.material) return;
  mesh.material.wireframe = false;
  mesh.material.needsUpdate = true;
}

/* ----------------------------- Heat ----------------------------- */
function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function heatToVisual(heat, overdo) {
  const h = clamp01(heat);

  let color = new THREE.Color(0x7a7a7a);
  let emissive = new THREE.Color(0x000000);
  let eI = 0.0;

  if (overdo) {
    color = new THREE.Color(0xff3c3c);
    emissive = new THREE.Color(0xff3c3c);
    eI = 1.25;
    return { color, emissive, emissiveIntensity: eI };
  }

  if (h < 0.12) return { color, emissive, emissiveIntensity: eI };

  if (h < 0.35) emissive = new THREE.Color(0x3cff7a);
  else if (h < 0.6) emissive = new THREE.Color(0xffd84d);
  else emissive = new THREE.Color(0xff9b3c);

  return { color, emissive, emissiveIntensity: 0.8 };
}

/* ----------------------------- Loading model ----------------------------- */
function frameObject(obj) {
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

function clearModel() {
  if (currentModel) scene.remove(currentModel);
  currentModel = null;
  skinShellMeshes.length = 0;
  gymMeshes.length = 0;
  pickables.length = 0;
  selectedMesh = null;
}

async function loadGLBWithFallback() {
  // IMPORTANT: try plain first to avoid DRACO warning spam
  const candidates = [
    "./assets/models/body.glb",
    "./assets/models/body.draco.glb",
  ];

  for (const url of candidates) {
    try {
      await loadGLB(url);
      return;
    } catch (e) {
      console.warn("[GLB] failed:", url, e?.message || e);
    }
  }

  throw new Error("Could not load any model. Put body.glb in assets/models/.");
}

function loadGLB(url) {
  clearModel();
  const loader = new GLTFLoader();

  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (gltf) => {
        const model = gltf.scene;
        currentModel = model;

        model.scale.setScalar(1);
        model.position.set(0, 0, 0);

        applyClassification(model);
        scene.add(model);
        frameObject(model);

        applyHeatToAllMeshes();
        resolve();
      },
      undefined,
      (err) => reject(err)
    );
  });
}

function applyClassification(root) {
  const skinMat = makeSkinMaterial();

  root.traverse((obj) => {
    if (!obj.isMesh) return;

    const info = classifyMeshName(obj.name);

    if (info.kind === "shell") {
      obj.material = skinMat;
      obj.renderOrder = 2;
      obj.frustumCulled = true;
      obj.visible = true;
      skinShellMeshes.push(obj);
      return;
    }

    if (info.kind === "gym") {
      obj.visible = true;
      obj.renderOrder = 1;
      obj.frustumCulled = true;

      const base = makeBaselineMuscleMaterial();
      obj.material = base;
      obj.userData._muscle = {
        groups: info.groups || [],
        baseMaterial: base,
      };

      gymMeshes.push({ mesh: obj, groups: obj.userData._muscle.groups });
      pickables.push(obj);
      return;
    }

    obj.visible = false;
  });
}

/* ----------------------------- Picking ----------------------------- */
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downAt = null;

function getPointerNDC(ev) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set(
    ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    -(((ev.clientY - rect.top) / rect.height) * 2 - 1)
  );
}

renderer.domElement.addEventListener("pointerdown", (ev) => {
  downAt = { x: ev.clientX, y: ev.clientY, t: performance.now() };
});

renderer.domElement.addEventListener("pointerup", (ev) => {
  if (!downAt) return;
  const dx = Math.abs(ev.clientX - downAt.x);
  const dy = Math.abs(ev.clientY - downAt.y);
  const dt = performance.now() - downAt.t;
  downAt = null;
  if (dx > 6 || dy > 6 || dt > 500) return;

  getPointerNDC(ev);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(pickables, true);
  if (!hits.length) return clearSelected();
  setSelected(hits[0].object);
});

/* ----------------------------- Selection ----------------------------- */
function prettyGroupId(id) {
  return (id || "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function setSelected(mesh) {
  if (selectedMesh === mesh) return clearSelected();
  clearSelected();
  selectedMesh = mesh;

  applyHeatToMesh(mesh);
  applySelectionLook(mesh);

  const groups = mesh.userData?._muscle?.groups || [];
  selectedBox.querySelector(".selected-name").textContent = mesh.name || "(unnamed)";
  selectedBox.querySelector(".selected-meta").textContent =
    groups.length ? groups.map(prettyGroupId).join(", ") : "Unknown";
}

function clearSelected() {
  if (!selectedMesh) return;
  clearSelectionLook(selectedMesh);
  applyHeatToMesh(selectedMesh);
  selectedMesh = null;
  selectedBox.querySelector(".selected-name").textContent = "None";
  selectedBox.querySelector(".selected-meta").textContent = "Click a muscle.";
}

/* ----------------------------- Heat apply ----------------------------- */
function applyHeatToMesh(mesh, now = Date.now()) {
  const groups = mesh.userData?._muscle?.groups || [];
  let maxHeat = 0;
  let overdo = false;

  for (const g of groups) {
    const h = computeHeat(state, g, now);
    maxHeat = Math.max(maxHeat, h.heat);
    if (h.overdo) overdo = true;
  }

  const v = heatToVisual(maxHeat, overdo);
  mesh.material.color = v.color;
  mesh.material.emissive = v.emissive;
  mesh.material.emissiveIntensity = v.emissiveIntensity;
  mesh.material.wireframe = false;
}

function applyHeatToAllMeshes(now = Date.now()) {
  for (const { mesh } of gymMeshes) applyHeatToMesh(mesh, now);
  if (selectedMesh) applySelectionLook(selectedMesh);
}

/* ----------------------------- Recs ----------------------------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function renderRecs() {
  if (!recsBox) return;

  const groupSet = new Set();
  for (const { groups } of gymMeshes) for (const g of groups) groupSet.add(g);

  const recs = generateRecs(state, [...groupSet], Date.now());
  recsBox.innerHTML = recs.length
    ? recs.map((r) => `<div class="rec">${escapeHtml(r.text)}</div>`).join("")
    : `<div class="muted">Looking balanced. Keep it up.</div>`;
}

/* ----------------------------- Logs ----------------------------- */
function renderLogs() {
  const out = state.logs.slice(0, 20).map((l) => `
    <div class="log">
      <div class="log-top">
        <div class="log-ex">${escapeHtml(l.exerciseName)}</div>
        <div class="log-date">${escapeHtml(l.date)}</div>
      </div>
      <div class="log-meta">${l.sets}×${l.reps}${(l.loadLbs ?? null) !== null ? ` • ${escapeHtml(l.loadLbs)} lbs` : ""}</div>
    </div>
  `).join("");

  logsBox.innerHTML = out || `<div class="muted">No logs yet.</div>`;
}

/* ----------------------------- Workout logging ----------------------------- */
function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function renderExerciseOptions() {
  exerciseSelect.innerHTML = "";
  for (const ex of EXERCISES) {
    const opt = document.createElement("option");
    opt.value = ex.id;
    opt.textContent = ex.name;
    exerciseSelect.appendChild(opt);
  }
}

function computeStimulus(sets, reps, loadLbs) {
  const vol = Math.max(1, sets * reps);

  let loadFactor = 1.0;
  if (Number.isFinite(loadLbs) && loadLbs > 0) {
    loadFactor = 1.0 + Math.min(1.0, loadLbs / 200);
  }

  const base = (vol / 60) * loadFactor;
  return clamp01(base);
}

async function onLogWorkout(ev) {
  ev.preventDefault();

  const date = (dateInput?.value || todayISO()).trim();
  const exId = exerciseSelect.value;
  const ex = getExerciseById(exId);
  if (!ex) return;

  const sets = Math.max(1, parseInt(setsInput.value || "1", 10));
  const reps = Math.max(1, parseInt(repsInput.value || "1", 10));
  const loadLbsRaw = loadInput.value.trim();
  const loadLbs = loadLbsRaw === "" ? null : Math.max(0, parseFloat(loadLbsRaw));

  // decay local view before applying new stimulus
  tickDecay(state, Date.now());

  const stim = computeStimulus(sets, reps, loadLbs);

  // build muscles payload { groupId: weight }
  const muscles = {};
  for (const [gid, w] of Object.entries(ex.w || {})) {
    if (!Number.isFinite(w)) continue;
    muscles[gid] = w;
    applyStimulus(state, gid, stim * w, Date.now()); // local prediction
  }

  // send to server (this is the real persistence)
  await apiJson(API_WORKOUT_LOG, {
    method: "POST",
    body: JSON.stringify({
      date,
      exercise_id: ex.id,
      exercise_name: ex.name,
      sets,
      reps,
      load_lbs: loadLbs,
      stimulus: stim,
      muscles
    }),
  });

  // reload from server to be authoritative
  await loadLogsServer();
  await loadMuscleStateServer();

  renderLogs();
  renderRecs();
  applyHeatToAllMeshes();

  if (dateInput && !dateInput.value) dateInput.value = todayISO();
}

async function resetStateServer() {
  try {
    const res = await fetch(API_STATE_RESET, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" }
    });

    const text = await res.text();
    const json = JSON.parse(text);

    return json && json.ok === true;
  } catch (e) {
    console.warn("[reset] failed:", e);
    return false;
  }
}

function makeDefaultState() {
  return {
    logs: [],
    muscle: {},
    lastUpdate: Date.now(),
  };
}



/* ----------------------------- UI wiring ----------------------------- */
renderExerciseOptions();
if (dateInput) dateInput.value = todayISO();

if (logForm) logForm.addEventListener("submit", onLogWorkout);

if (recsBtn) {
  recsBtn.addEventListener("click", async () => {
    // just recompute UI using current state; no auto-save spam
    tickDecay(state, Date.now());
    renderRecs();
    applyHeatToAllMeshes();
  });
}

if (resetBtn) {
  resetBtn.addEventListener("click", async () => {
    if (!confirm("Reset ALL MuscleMap data? This wipes the shared database.")) return;

    const ok = await resetStateServer();
    if (!ok) {
      alert("Reset failed. Check server logs.");
      return;
    }

    state = makeDefaultState();
    tickDecay(state, Date.now());

    clearSelected();
    renderLogs();
    renderRecs();
    applyHeatToAllMeshes();

    alert("All data reset.");
  });
}


/* ----------------------------- Resize ----------------------------- */
window.addEventListener("resize", () => {
  renderer.setSize(mount.clientWidth, mount.clientHeight);
  camera.aspect = mount.clientWidth / mount.clientHeight;
  camera.updateProjectionMatrix();
});

/* ----------------------------- Boot ----------------------------- */
async function boot() {
  await loadLogsServer();
  await loadMuscleStateServer();

  // makes the view look correct immediately
  tickDecay(state, Date.now());

  renderLogs();
  renderRecs();

  loadGLBWithFallback().catch((e) => {
    console.error(e);
    alert("Model load failed. Put assets/models/body.glb in place.");
  });
}
boot();

/* ----------------------------- Loop ----------------------------- */
let lastDecayAt = Date.now();

function animate() {
  requestAnimationFrame(animate);

  const now = Date.now();
  if (now - lastDecayAt > 2000) {
    lastDecayAt = now;
    tickDecay(state, now);
    applyHeatToAllMeshes(now);
    renderRecs();
  }

  controls.update();
  renderer.render(scene, camera);
}
animate();
