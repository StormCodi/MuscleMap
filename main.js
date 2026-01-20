// main.js
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
// NOTE: not requiring DRACO for this app. We'll try body.draco.glb first, then fall back to body.glb.
// If you later add DRACO decoder files, we can enable DRACOLoader.

import { EXERCISES, getExerciseById } from "./lib/exercises.js";
import { classifyMeshName } from "./lib/muscleMap.js";
import { loadState, saveState, resetState } from "./lib/storage.js";
import { tickDecay, applyStimulus, computeHeat, ensureMuscle } from "./lib/recovery.js";
import { generateRecs } from "./lib/recs.js";

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
let state = loadState();
// decay immediately so it looks right on load
tickDecay(state, Date.now());
saveState(state);

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

// “human stand-in” skin shell meshes (always visible)
const skinShellMeshes = [];

// gym-relevant meshes (clickable + heat-colored)
const gymMeshes = []; // { mesh, groups: string[] }

// quick array of pickables (meshes only)
const pickables = [];

// selection
let selectedMesh = null;

// neglected alert pulse
let pulse = null; // { until:number, groupId:string }
let lastGlobalBeepAt = 0;

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
  // subtle “human stand-in” shell (keeps it from being creepy)
  // IMPORTANT: not trying to be realistic skin; just a soft translucent cover.
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

// selection styling (applied on top of heat without swapping materials)
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

/* ----------------------------- Heat -> color mapping ----------------------------- */
function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

// not using pure red unless overdoing / warnings
function heatToVisual(heat, overdo) {
  const h = clamp01(heat);

  // base
  let color = new THREE.Color(0x7a7a7a);
  let emissive = new THREE.Color(0x000000);
  let eI = 0.0;

  if (overdo) {
    // reserved red: ignoring recovery signals / overdoing
    color = new THREE.Color(0xff3c3c);
    emissive = new THREE.Color(0xff3c3c);
    eI = 1.25;
    return { color, emissive, emissiveIntensity: eI };
  }

  if (h < 0.12) {
    // baseline gray
    return { color, emissive, emissiveIntensity: eI };
  }

  // green -> yellow -> orange
  if (h < 0.35) {
    color = new THREE.Color(0x7a7a7a);
    emissive = new THREE.Color(0x3cff7a);
    eI = 0.65;
  } else if (h < 0.60) {
    emissive = new THREE.Color(0xffd84d);
    eI = 0.72;
  } else if (h < 0.85) {
    emissive = new THREE.Color(0xff9b3c);
    eI = 0.80;
  } else {
    // very high load but not “red” unless overdo is true
    emissive = new THREE.Color(0xff9b3c);
    eI = 0.95;
  }

  return { color, emissive, emissiveIntensity: eI };
}

/* ----------------------------- Console helpers ----------------------------- */
function sep(label = "") {
  const line = "────────────────────────────────────────";
  console.log(label ? `${line}\n${label}\n${line}` : line);
}

function prettyGroupId(id) {
  return (id || "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
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
  // Try draco first (if you have it), then fallback to plain glb.
  const candidates = [
    "./assets/models/body.draco.glb",
    "./assets/models/body.glb",
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

  sep(`[GLB] start: ${url}`);

  // progress % logging (throttled)
  const lastPct = { v: -999 };
  const lastTime = { v: 0 };

  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (gltf) => {
        const model = gltf.scene;
        currentModel = model;

        // Normalize transforms
        model.scale.setScalar(1);
        model.position.set(0, 0, 0);

        applyClassification(model);
        scene.add(model);
        frameObject(model);

        sep(`[GLB] done: ${url}`);
        console.log("Skin shell meshes:", skinShellMeshes.length);
        console.log("Gym muscles (clickable):", pickables.length);

        // apply heat immediately
        applyHeatToAllMeshes();

        resolve();
      },
      (xhr) => {
        if (!xhr) return;
        const total = xhr.total || 0;
        const loaded = xhr.loaded || 0;

        let pct = 0;
        if (total > 0) pct = Math.floor((loaded / total) * 100);

        // throttle: log every 5% or every 700ms
        const now = performance.now();
        const shouldLog =
          total > 0
            ? pct >= lastPct.v + 5
            : now - lastTime.v > 700;

        if (shouldLog) {
          lastPct.v = pct;
          lastTime.v = now;

          if (total > 0) {
            console.log(`[GLB] ${pct}% (${(loaded / 1024 / 1024).toFixed(1)}MB / ${(total / 1024 / 1024).toFixed(1)}MB)`);
          } else {
            console.log(`[GLB] ${(loaded / 1024 / 1024).toFixed(1)}MB loaded`);
          }
        }
      },
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
      // stand-in “human” cover
      obj.material = skinMat;
      obj.renderOrder = 2; // render after muscles
      obj.frustumCulled = true;
      obj.visible = true;
      skinShellMeshes.push(obj);
      return;
    }

    if (info.kind === "gym") {
      // gym muscle: visible, clickable, heat-colored
      obj.visible = true;
      obj.renderOrder = 1;
      obj.frustumCulled = true;

      // store baseline material per mesh so it’s independent
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

    // ignore everything else (bones, micro, etc.)
    obj.visible = false;
  });

  // small sanity log
  const totalMeshes = [];
  root.traverse((o) => o.isMesh && totalMeshes.push(o));
  console.log("Total meshes:", totalMeshes.length);

  // show a sample list (cleaner in console)
  const sample = gymMeshes.slice(0, 20).map((x) => x.mesh.name);
  sep("Sample gym muscles:");
  console.log(sample);
}

/* ----------------------------- Picking / selection ----------------------------- */
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downAt = null;

function getPointerNDC(ev) {
  const rect = renderer.domElement.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  const y = -(((ev.clientY - rect.top) / rect.height) * 2 - 1);
  pointer.set(x, y);
}

function setSelected(mesh) {
  if (selectedMesh === mesh) {
    clearSelected();
    return;
  }

  clearSelected();
  selectedMesh = mesh;

  if (!selectedMesh) return;

  applyHeatToMesh(selectedMesh); // baseline first
  applySelectionLook(selectedMesh);

  const name = selectedMesh.name || "(unnamed)";
  const groups = selectedMesh.userData?._muscle?.groups || [];
  const groupText = groups.length ? groups.map(prettyGroupId).join(", ") : "Unknown";

  // UI
  if (selectedBox) {
    selectedBox.querySelector(".selected-name").textContent = name;
    selectedBox.querySelector(".selected-meta").textContent = groupText;
  }

  // console (with separators)
  sep("Selected gym muscle");
  console.log("Name:", name);
  console.log("Groups:", groups);
  for (const gid of groups) {
    const h = computeHeat(state, gid, Date.now());
    console.log(`- ${gid}: heat=${h.heat.toFixed(2)} load=${h.load.toFixed(2)} overdo=${!!h.overdo}`);
  }
}

function clearSelected() {
  if (!selectedMesh) return;

  // remove selection look then restore heat styling
  clearSelectionLook(selectedMesh);
  applyHeatToMesh(selectedMesh);

  selectedMesh = null;

  if (selectedBox) {
    selectedBox.querySelector(".selected-name").textContent = "None";
    selectedBox.querySelector(".selected-meta").textContent = "Click a muscle.";
  }
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

  // don’t select while rotating
  const isClick = dx < 6 && dy < 6 && dt < 500;
  if (!isClick) return;

  if (!currentModel) return;

  getPointerNDC(ev);
  raycaster.setFromCamera(pointer, camera);

  const hits = raycaster.intersectObjects(pickables, true);
  if (!hits.length) {
    clearSelected();
    return;
  }

  // pick nearest gym mesh
  const hit = hits[0]?.object;
  if (!hit) {
    clearSelected();
    return;
  }

  setSelected(hit);
});

/* ----------------------------- Heat application ----------------------------- */
function getMeshHeat(mesh, now = Date.now()) {
  const groups = mesh.userData?._muscle?.groups || [];
  if (!groups.length) return { heat: 0, overdo: false };

  // mesh heat = max of its groups (simple + effective)
  let maxHeat = 0;
  let anyOverdo = false;

  for (const gid of groups) {
    const h = computeHeat(state, gid, now);
    maxHeat = Math.max(maxHeat, h.heat);
    if (h.overdo) anyOverdo = true;
  }

  return { heat: maxHeat, overdo: anyOverdo };
}

function applyHeatToMesh(mesh, now = Date.now()) {
  if (!mesh?.material) return;

  const { heat, overdo } = getMeshHeat(mesh, now);
  const v = heatToVisual(heat, overdo);

  // pulse override (neglect warning)
  if (pulse && now < pulse.until) {
    const groups = mesh.userData?._muscle?.groups || [];
    if (groups.includes(pulse.groupId)) {
      const t = (pulse.until - now) / 1000;
      const p = 0.5 + 0.5 * Math.sin((1 - t) * Math.PI * 6);
      mesh.material.emissive = new THREE.Color(0xff3c3c);
      mesh.material.emissiveIntensity = 0.6 + p * 0.8;
      mesh.material.color = new THREE.Color(0x7a7a7a);
      mesh.material.wireframe = true;
      return;
    }
  }

  // normal heat
  mesh.material.color = v.color;
  mesh.material.emissive = v.emissive;
  mesh.material.emissiveIntensity = v.emissiveIntensity;

  // if it’s selected, selection look will re-apply after this
  mesh.material.wireframe = false;
}

function applyHeatToAllMeshes(now = Date.now()) {
  // decay already applied elsewhere; here is just styling
  for (const { mesh } of gymMeshes) {
    applyHeatToMesh(mesh, now);
  }

  // keep selection visible
  if (selectedMesh) {
    applySelectionLook(selectedMesh);
  }
}

/* ----------------------------- Beep + neglect pulse ----------------------------- */
function beep() {
  // avoid spam
  const now = Date.now();
  if (now - lastGlobalBeepAt < 2500) return;
  lastGlobalBeepAt = now;

  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = 880;
    g.gain.value = 0.0001;

    o.connect(g);
    g.connect(ctx.destination);

    o.start();
    g.gain.exponentialRampToValueAtTime(0.10, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
    o.stop(ctx.currentTime + 0.24);

    o.onended = () => ctx.close();
  } catch {
    // ignore audio errors
  }
}

function maybeNeglectPulse(now = Date.now()) {
  // pick a “most neglected” group among visible gym groups:
  // - low heat
  // - long time since trained
  // - not pinged recently

  // collect unique group ids from meshes
  const groupSet = new Set();
  for (const { groups } of gymMeshes) for (const g of groups) groupSet.add(g);

  let best = null;

  for (const gid of groupSet) {
    const m = ensureMuscle(state, gid);
    const h = computeHeat(state, gid, now);
    const last = m.lastTrained || 0;
    const daysSince = last ? (now - last) / (1000 * 60 * 60 * 24) : 999;

    const lastPing = m.lastPing || 0;
    const hoursSincePing = lastPing ? (now - lastPing) / (1000 * 60 * 60) : 999;

    // criteria:
    const lowHeat = h.heat < 0.14;
    const neglected = daysSince >= 8 || last === 0;

    if (!lowHeat || !neglected) continue;
    if (hoursSincePing < 24) continue; // don’t nag constantly

    const score = daysSince * 10 + (1 - h.heat) * 5; // bigger is worse
    if (!best || score > best.score) best = { gid, score };
  }

  if (!best) return;

  // pulse + beep
  state.muscle[best.gid].lastPing = now;
  saveState(state);

  pulse = { groupId: best.gid, until: now + 1400 };

  sep("Neglect nudge");
  console.warn(`Hey champ: ${prettyGroupId(best.gid)} is lagging. Add some work.`);

  beep();
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
  // Simple and stable:
  // volume = sets*reps
  // load factor: mild boost (so bodyweight still counts)
  const vol = Math.max(1, sets * reps);

  let loadFactor = 1.0;
  if (Number.isFinite(loadLbs) && loadLbs > 0) {
    loadFactor = 1.0 + Math.min(1.0, loadLbs / 200); // cap boost
  }

  // normalize into 0..~1 range per log
  const base = (vol / 60) * loadFactor; // 60 reps @ moderate load ~ 1.0
  return clamp01(base);
}

function addLogToState(entry) {
  state.logs.unshift(entry);
  // cap logs stored
  if (state.logs.length > 250) state.logs.length = 250;
}

function renderLogs() {
  if (!logsBox) return;

  logsBox.innerHTML = "";

  const logs = state.logs.slice(0, 20);
  if (!logs.length) {
    logsBox.innerHTML = `<div class="muted">No logs yet.</div>`;
    return;
  }

  for (const l of logs) {
    const el = document.createElement("div");
    el.className = "log";
    el.innerHTML = `
      <div class="log-top">
        <div class="log-ex">${escapeHtml(l.exerciseName)}</div>
        <div class="log-date">${escapeHtml(l.date)}</div>
      </div>
      <div class="log-meta">
        ${l.sets} sets × ${l.reps} reps${(l.loadLbs ?? null) !== null ? ` • ${l.loadLbs} lbs` : ""}
      </div>
    `;
    logsBox.appendChild(el);
  }
}

function renderRecs() {
  if (!recsBox) return;

  // choose group ids from current model, else from state keys
  const groupSet = new Set();
  for (const { groups } of gymMeshes) for (const g of groups) groupSet.add(g);

  const groupIds = [...groupSet];
  const recs = generateRecs(state, groupIds, Date.now());

  if (!recs.length) {
    recsBox.innerHTML = `<div class="muted">Looking balanced. Keep it up.</div>`;
    return;
  }

  recsBox.innerHTML = "";
  for (const r of recs) {
    const div = document.createElement("div");
    div.className = "rec";
    div.textContent = r.text;
    recsBox.appendChild(div);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&":"&amp;",
    "<":"&lt;",
    ">":"&gt;",
    '"':"&quot;",
    "'":"&#39;"
  }[c]));
}

function onLogWorkout(ev) {
  ev.preventDefault();

  const date = (dateInput?.value || todayISO()).trim();
  const exId = exerciseSelect.value;
  const ex = getExerciseById(exId);
  if (!ex) return;

  const sets = Math.max(1, parseInt(setsInput.value || "1", 10));
  const reps = Math.max(1, parseInt(repsInput.value || "1", 10));
  const loadLbsRaw = loadInput.value.trim();
  const loadLbs = loadLbsRaw === "" ? null : Math.max(0, parseFloat(loadLbsRaw));

  // decay before applying new stimulus
  tickDecay(state, Date.now());

  const stim = computeStimulus(sets, reps, loadLbs);

  // apply per group weight
  for (const [gid, w] of Object.entries(ex.w || {})) {
    if (!Number.isFinite(w)) continue;
    applyStimulus(state, gid, stim * w, Date.now());
  }

  // save log
  addLogToState({
    id: crypto?.randomUUID?.() || String(Date.now()),
    date,
    exerciseId: ex.id,
    exerciseName: ex.name,
    sets,
    reps,
    loadLbs,
    stimulus: stim
  });

  saveState(state);

  sep("Workout logged");
  console.log(`${ex.name} — stimulus=${stim.toFixed(2)} (sets=${sets}, reps=${reps}, load=${loadLbs ?? "n/a"})`);

  renderLogs();
  renderRecs();
  applyHeatToAllMeshes();

  // keep date at what user chose; but if empty, set to today
  if (dateInput && !dateInput.value) dateInput.value = todayISO();
}

/* ----------------------------- UI wiring ----------------------------- */
renderExerciseOptions();

if (dateInput) dateInput.value = todayISO();

if (logForm) logForm.addEventListener("submit", onLogWorkout);

if (recsBtn) {
  recsBtn.addEventListener("click", () => {
    tickDecay(state, Date.now());
    saveState(state);
    renderRecs();
    applyHeatToAllMeshes();
    maybeNeglectPulse(Date.now());
  });
}

if (resetBtn) {
  resetBtn.addEventListener("click", () => {
    if (!confirm("Reset MuscleMap data? This clears logs + heat states.")) return;
    resetState();
    state = loadState();
    tickDecay(state, Date.now());
    saveState(state);

    clearSelected();
    renderLogs();
    renderRecs();
    applyHeatToAllMeshes();
    sep("Data reset");
  });
}

/* ----------------------------- Resize ----------------------------- */
window.addEventListener("resize", () => {
  renderer.setSize(mount.clientWidth, mount.clientHeight);
  camera.aspect = mount.clientWidth / mount.clientHeight;
  camera.updateProjectionMatrix();
});

/* ----------------------------- Boot ----------------------------- */
renderLogs();
renderRecs();

loadGLBWithFallback().catch((e) => {
  console.error(e);
  alert("Model load failed. Put assets/models/body.glb in place.");
});

/* ----------------------------- Main loop ----------------------------- */
let lastDecayAt = Date.now();

function animate() {
  requestAnimationFrame(animate);

  // decay + refresh every ~2 seconds (cheap)
  const now = Date.now();
  if (now - lastDecayAt > 2000) {
    lastDecayAt = now;
    tickDecay(state, now);
    saveState(state);

    applyHeatToAllMeshes(now);
    renderRecs();

    // occasional nudge
    maybeNeglectPulse(now);
  }

  // pulse effect will be applied inside applyHeatToMesh when needed
  if (pulse && now >= pulse.until) {
    pulse = null;
    applyHeatToAllMeshes(now);
  }

  // keep selection visible over heat
  if (selectedMesh) applySelectionLook(selectedMesh);

  controls.update();
  renderer.render(scene, camera);
}
animate();
