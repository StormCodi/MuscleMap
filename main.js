// main.js
import { getAllExercisesCached } from "./lib/exercises.js";
import { classifyMeshName } from "./lib/muscleMap.js";
import { computeHeat } from "./lib/recovery.js";
import { generateRecs } from "./lib/recs.js";

import { API, apiJson, resetStateServer } from "./lib/api.js";
import { createHeatEngine } from "./lib/heat_engine.js";
import { createRenderer3D } from "./lib/renderer3d.js";
import { createWorkoutUI } from "./lib/workout_ui.js";

/* ==============================
   URL params (NEW)
============================== */
const __params = new URLSearchParams(window.location.search || "");
const __newExFromAi = String(__params.get("new_ex") || "").trim();

/* ==============================
   DOM refs
============================== */
const mount = document.getElementById("view");
if (!mount) throw new Error("Missing #view element");

const heatOverallBtn = document.getElementById("heatOverallBtn");
const heatWorkoutBtn = document.getElementById("heatWorkoutBtn");

const selectedBox = document.getElementById("selectedBox");

// NEW: sensitivity UI refs (from index.html)
const sensWrap = document.getElementById("sensWrap");
const sensSlider = document.getElementById("sensSlider");
const sensValue = document.getElementById("sensValue");
const sensSaveBtn = document.getElementById("sensSaveBtn");
const sensResetBtn = document.getElementById("sensResetBtn");
const sensStatus = document.getElementById("sensStatus");

const recsBox = document.getElementById("recsBox");
const recsBtn = document.getElementById("recsBtn");
const resetBtn = document.getElementById("resetBtn");

const startWorkoutBtn = document.getElementById("startWorkoutBtn");
const endWorkoutBtn = document.getElementById("endWorkoutBtn");

const workTitle = document.getElementById("workTitle");
const timerText = document.getElementById("timerText");
const statusText = document.getElementById("statusText");

const workControls = document.getElementById("workControls");
const exerciseSelect = document.getElementById("exerciseSelect");
const addExerciseBtn = document.getElementById("addExerciseBtn");

const workoutEditor = document.getElementById("workoutEditor");
const editorFooter = document.getElementById("editorFooter");
const discardEditBtn = document.getElementById("discardEditBtn");
const saveEditBtn = document.getElementById("saveEditBtn");

const historyBox = document.getElementById("historyBox");
const prevPageBtn = document.getElementById("prevPageBtn");
const nextPageBtn = document.getElementById("nextPageBtn");
const pageHint = document.getElementById("pageHint");

/* ==============================
   Small utils kept here
============================== */
function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function clampSens(x) {
  if (!Number.isFinite(x)) return 1.0;
  return Math.max(0.05, Math.min(1.5, x));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function prettyGroupId(id) {
  return (id || "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// per-set stimulus formula
function computeStimulusSingleSet(reps, loadLbs) {
  const vol = Math.max(1, reps);
  let loadFactor = 1.0;
  if (Number.isFinite(loadLbs) && loadLbs > 0) {
    loadFactor = 1.0 + Math.min(1.0, loadLbs / 200);
  }
  const base = (vol / 12) * loadFactor;
  return clamp01(base);
}

/* ==============================
   Heat engine
============================== */
const heat = createHeatEngine({
  apiJson,
  API,
  historyPerPage: 5,
  maxWorkouts: 40,
  maxAgeMs: 2 * 60 * 1000,
});

/* ==============================
   Sensitivity system state
============================== */
let selectedGroups = [];

function setSensStatus(msg) {
  if (sensStatus) sensStatus.textContent = msg || "";
}

function setSensUIVisible(yes) {
  if (!sensWrap) return;
  sensWrap.classList.toggle("hidden", !yes);
}

function setSensUIValue(v) {
  const val = clampSens(Number(v));
  if (sensSlider) sensSlider.value = String(val);
  if (sensValue) sensValue.textContent = `${val.toFixed(2)}×`;
}

async function loadSensitivityFromServer() {
  // PHP returns: { ok:true, map:{ group_id: sensitivity, ... } }
  const data = await apiJson(API.SENSITIVITY_GET, { method: "GET" });
  const map = (data && data.map && typeof data.map === "object") ? data.map : {};
  heat.setSensitivityMap(map);
}

async function saveSensitivityForSelected(v) {
  const sens = clampSens(Number(v));
  if (!selectedGroups.length) return;

  setSensStatus("Saving...");
  try {
    // PHP accepts: { map: { "chest": 1.2, "biceps": 0.9 } }
    const map = {};
    for (const gid of selectedGroups) map[gid] = sens;

    await apiJson(API.SENSITIVITY_SET, {
      method: "POST",
      body: JSON.stringify({ map }),
    });

    heat.setSensitivityForGroups(selectedGroups, sens);
    await rebuildHeatAndPaint();
    setSensStatus("Saved.");
    setTimeout(() => setSensStatus(""), 900);
  } catch (e) {
    console.warn("[sens] save failed:", e);
    setSensStatus("Save failed.");
  }
}

async function resetSensitivityForSelected() {
  if (!selectedGroups.length) return;

  const sens = 1.0;
  setSensUIValue(sens);
  heat.setSensitivityForGroups(selectedGroups, sens);
  renderer3d.applyHeatToAllMeshes(heat.getState(), Date.now());
  setSensStatus("");

  // optional: persist reset to DB
  await saveSensitivityForSelected(sens);
}

/* ==============================
   Selected panel UI
============================== */
function setSelectedPanel({ name, groups }) {
  if (!selectedBox) return;

  const nameEl = selectedBox.querySelector(".selected-name");
  const metaEl = selectedBox.querySelector(".selected-meta");

  if (nameEl) nameEl.textContent = name || "None";
  if (metaEl) {
    metaEl.textContent = (groups && groups.length)
      ? groups.map(prettyGroupId).join(", ")
      : "Tap a muscle.";
  }

  selectedGroups = Array.isArray(groups) ? groups : [];

  if (!selectedGroups.length) {
    setSensUIVisible(false);
    setSensStatus("");
    return;
  }

  setSensUIVisible(true);

  // Use first group as the displayed value (single-slider UI)
  const map = heat.getSensitivityMap();
  const gid = selectedGroups[0];
  const v = clampSens(Number(map?.[gid] ?? 1.0));
  setSensUIValue(v);
  setSensStatus("");
}

/* ==============================
   Renderer
============================== */
const renderer3d = createRenderer3D({
  mount,
  classifyMeshName,
  computeHeat,
  onSelect: ({ name, groups }) => {
    setSelectedPanel({ name: name || "None", groups: groups || [] });
  },
});

/* ==============================
   Recs render
============================== */
function renderRecsFromState(state, now = Date.now()) {
  if (!recsBox) return;

  const groupIds = renderer3d.getAllGroupIds();
  const recs = generateRecs(state, groupIds, now);

  recsBox.innerHTML = recs.length
    ? recs.map((r) => `<div class="rec">${escapeHtml(r.text)}</div>`).join("")
    : `<div class="muted">Looking balanced. Keep it up.</div>`;
}

/* ==============================
   Workout UI
============================== */
const workoutUI = createWorkoutUI({
  dom: {
    heatOverallBtn,
    heatWorkoutBtn,

    startWorkoutBtn,
    endWorkoutBtn,

    workTitle,
    timerText,
    statusText,

    workControls,
    exerciseSelect,
    addExerciseBtn,

    workoutEditor,
    editorFooter,
    discardEditBtn,
    saveEditBtn,

    historyBox,
    prevPageBtn,
    nextPageBtn,
    pageHint,

    getHeatMode: () => heat.getMode(),
  },

  apiJson,
  getExerciseById: async (id) => {
    const mod = await import("./lib/exercises.js");
    return mod.getExerciseById(id);
  },
  computeStimulusSingleSet,

  onEditorSetsChanged: (sets) => {
  heat.setWorkoutSets(sets);

  // If user is viewing workout heat, repaint immediately (don’t wait for the 2s loop)
  if (heat.getMode() === "workout") {
    rebuildHeatAndPaint().catch((e) => console.warn("[heat] rebuild failed:", e));
  } else {
    // Even in overall mode, keep visuals consistent in case anything else depends on state
    // (safe no-op-ish; rebuildNow will use cache)
    renderer3d.applyHeatToAllMeshes(heat.getState(), Date.now());
  }
},


  onHeatAvailabilityChanged: ({ canWorkoutHeat }) => {
    if (!canWorkoutHeat && heat.getMode() === "workout") {
      setHeatMode("overall");
    }
  },
});

/* ==============================
   Heat mode UI + rebuild
============================== */
function setHeatButtons() {
  const mode = heat.getMode();
  if (heatOverallBtn) heatOverallBtn.classList.toggle("on", mode === "overall");
  if (heatWorkoutBtn) heatWorkoutBtn.classList.toggle("on", mode === "workout");

  const canWorkoutHeat = workoutUI.canWorkoutHeat();
  if (heatWorkoutBtn) heatWorkoutBtn.disabled = !canWorkoutHeat;
}

async function rebuildHeatAndPaint() {
  const state = await heat.rebuildNow();
  renderer3d.applyHeatToAllMeshes(state, Date.now());
  renderRecsFromState(state, Date.now());
}

function setHeatMode(mode) {
  heat.setMode(mode);
  setHeatButtons();
  rebuildHeatAndPaint().catch((e) => console.warn("[heat] rebuild failed:", e));
}

if (heatOverallBtn) heatOverallBtn.addEventListener("click", () => setHeatMode("overall"));
if (heatWorkoutBtn) heatWorkoutBtn.addEventListener("click", () => setHeatMode("workout"));

/* ==============================
   Sensitivity UI events
============================== */
if (sensSlider) {
  sensSlider.addEventListener("input", async () => {
    const v = clampSens(Number(sensSlider.value));
    setSensUIValue(v);
    setSensStatus("Previewing...");
    heat.setSensitivityForGroups(selectedGroups, v);
    renderer3d.applyHeatToAllMeshes(heat.getState(), Date.now());
  });
}

if (sensSaveBtn) {
  sensSaveBtn.addEventListener("click", async () => {
    if (!selectedGroups.length) return;
    const v = clampSens(Number(sensSlider?.value ?? 1.0));
    await saveSensitivityForSelected(v);
  });
}

if (sensResetBtn) {
  sensResetBtn.addEventListener("click", () => {
    resetSensitivityForSelected();
    const v = clampSens(Number(sensSlider?.value ?? 1.0));
    heat.setSensitivityForGroups(selectedGroups, v);
    renderer3d.applyHeatToAllMeshes(heat.getState(), Date.now());
  });
}

/* ==============================
   Recs button
============================== */
if (recsBtn) {
  recsBtn.addEventListener("click", async () => {
    try {
      await rebuildHeatAndPaint();
    } catch (e) {
      console.warn("[recs] rebuild failed:", e);
      const st = heat.getState();
      renderer3d.applyHeatToAllMeshes(st, Date.now());
      renderRecsFromState(st, Date.now());
    }
  });
}

/* ==============================
   Reset button (server wipe)
============================== */
if (resetBtn) {
  resetBtn.addEventListener("click", async () => {
    if (!confirm("Reset ALL MuscleMap data? This wipes the shared database.")) return;

    const ok = await resetStateServer();
    if (!ok) {
      alert("Reset failed. Check server logs.");
      return;
    }

    heat.clearAllLocalState();
    renderer3d.clearSelected();
    setSelectedPanel({ name: "None", groups: [] });

    await workoutUI.boot().catch(() => {});
    setHeatMode("overall");

    alert("All data reset.");
  });
}

/* ==============================
   Resize
============================== */
window.addEventListener("resize", () => {
  renderer3d.resize();
});

/* ==============================
   Boot
============================== */
function cleanupUrlParamsIfNeeded() {
  // Remove the AI redirect params so refresh doesn't keep reapplying.
  if (!__params.has("new_ex") && !__params.has("from_ai")) return;
  __params.delete("new_ex");
  __params.delete("from_ai");
  const qs = __params.toString();
  const base = window.location.pathname || "./index.html";
  const next = qs ? `${base}?${qs}` : base;
  try { window.history.replaceState({}, "", next); } catch {}
}

async function boot() {
  // exercises list
  try {
    const list = await getAllExercisesCached();
    const map = {};
    for (const ex of list) {
      map[ex.id] = ex.w || {};
      const opt = document.createElement("option");
      opt.value = ex.id;
      opt.textContent = ex.name;
      exerciseSelect.appendChild(opt);
    }
    heat.setExerciseWeightsById(map);
  } catch (e) {
    console.warn("[boot] exercises load failed:", e);
  }

  // load sensitivity (DB-backed)
  try {
    await loadSensitivityFromServer();
  } catch (e) {
    console.warn("[boot] sensitivity load failed:", e);
  }

  await workoutUI.boot();
  setHeatButtons();

  // NEW: preselect exercise after returning from AI, only if workout is active
  try {
    if (__newExFromAi) {
      const active = workoutUI.getActiveWorkout?.() || null;
      if (active && exerciseSelect) {
        // only set if option exists (don’t inject unknown keys)
        const opt = exerciseSelect.querySelector(`option[value="${CSS.escape(__newExFromAi)}"]`);
        if (opt) {
          exerciseSelect.value = __newExFromAi;
        }
      }
      cleanupUrlParamsIfNeeded();
    }
  } catch (e) {
    // ignore; never block boot
    cleanupUrlParamsIfNeeded();
    console.warn("[boot] ai preselect failed:", e);
  }

  // initial heat build
  try {
    await rebuildHeatAndPaint();
  } catch (e) {
    console.warn("[boot] heat build failed:", e);
  }

  // model
  renderer3d.loadGLBWithFallback().then(() => {
    const st = heat.getState();
    renderer3d.applyHeatToAllMeshes(st, Date.now());
  }).catch((e) => {
    console.error(e);
    alert("Model load failed.");
  });
}

boot();

/* ==============================
   Loop
============================== */
let lastHeatRebuildAt = Date.now();
let lastStatusPollAt = Date.now();

function animate() {
  requestAnimationFrame(animate);

  const now = Date.now();

  workoutUI.tickTimer(now);

  // periodically refresh heat visuals/recs (no network)
  if (now - lastHeatRebuildAt > 2000) {
    lastHeatRebuildAt = now;
    const st = heat.tick(now);
    renderer3d.applyHeatToAllMeshes(st, now);
    renderRecsFromState(st, now);
  }

  // poll status occasionally
  if (now - lastStatusPollAt > 15000) {
    lastStatusPollAt = now;

    workoutUI.refreshStatus()
      .then(() => {
        if (!workoutUI.getViewingWorkoutId() && !workoutUI.getActiveWorkout() && heat.getMode() === "workout") {
          setHeatMode("overall");
        }

        workoutUI.setWorkoutHeaderUI();
        setHeatButtons();
      })
      .catch(() => {});
  }

  renderer3d.renderFrame();
}

animate();
