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
   DOM refs
============================== */
const mount = document.getElementById("view");
if (!mount) throw new Error("Missing #view element");

const heatOverallBtn = document.getElementById("heatOverallBtn");
const heatWorkoutBtn = document.getElementById("heatWorkoutBtn");

const selectedBox = document.getElementById("selectedBox");

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

// per-set stimulus formula (same as your old one, just isolated)
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
   Selected panel UI
============================== */
function setSelectedPanel({ name, groups }) {
  if (!selectedBox) return;
  const nameEl = selectedBox.querySelector(".selected-name");
  const metaEl = selectedBox.querySelector(".selected-meta");
  if (nameEl) nameEl.textContent = name || "None";
  if (metaEl) metaEl.textContent = (groups && groups.length)
    ? groups.map(prettyGroupId).join(", ")
    : "Tap a muscle.";
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

    // allow workout_ui to read heat mode for button UI syncing
    getHeatMode: () => heat.getMode(),
  },

  apiJson,
  getExerciseById: async (id) => {
    // lazy import use (keeps workout_ui small)
    const mod = await import("./lib/exercises.js");
    return mod.getExerciseById(id);
  },
  computeStimulusSingleSet,

  onEditorSetsChanged: (sets) => {
    heat.setWorkoutSets(sets);
  },

  onHeatAvailabilityChanged: ({ canWorkoutHeat }) => {
    // if workout heat is impossible, force overall mode
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

// Heat mode toggles
if (heatOverallBtn) heatOverallBtn.addEventListener("click", () => setHeatMode("overall"));
if (heatWorkoutBtn) heatWorkoutBtn.addEventListener("click", () => setHeatMode("workout"));

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

    // clear local state
    heat.clearAllLocalState();
    renderer3d.clearSelected();
    setSelectedPanel({ name: "None", groups: [] });

    // refresh workout UI (will show no workout)
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
async function boot() {
  // exercises list (for select + optional fallback weights)
  try {
    const list = await getAllExercisesCached();
   const map = {}; // existing
   for (const ex of list) {
     map[ex.id] = ex.w || {};
     const opt = document.createElement("option");
     opt.value = ex.id;
     opt.textContent = ex.name;
     exerciseSelect.appendChild(opt);  // Add here
   }
    heat.setExerciseWeightsById(map);

    
  } catch (e) {
    console.warn("[boot] exercises load failed:", e);
  }

  await workoutUI.boot();
  setHeatButtons();

  // initial heat build
  try {
    await rebuildHeatAndPaint();
  } catch (e) {
    console.warn("[boot] heat build failed:", e);
  }

  // model
  renderer3d.loadGLBWithFallback().then(() => {
    // repaint after model loads
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

  // periodically refresh heat visuals/recs (no network; uses current state.logs)
  if (now - lastHeatRebuildAt > 2000) {
    lastHeatRebuildAt = now;
    const st = heat.tick(now);
    renderer3d.applyHeatToAllMeshes(st, now);
    renderRecsFromState(st, now);
  }

  // poll status occasionally so autoclose / other-tab changes reflect
  if (now - lastStatusPollAt > 15000) {
    lastStatusPollAt = now;

    workoutUI.refreshStatus()
      .then(() => {
        // if active workout disappeared while not editing a past workout, refresh view
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
