// lib/workout_ui.js
import { API } from "./api.js";
import { parseSqlDateTime, fmtElapsed, clampInt } from "./utils.js";
import { createSetTimerManager } from "./set_timers.js";
import { createWorkoutEditor } from "./workout_editor.js";
import { createWorkoutHistory } from "./workout_history.js";

/**
 * Workout UI module (orchestrator):
 * - Owns workout/past-edit state + header/buttons + boot/loaders.
 * - Delegates editor DOM/wiring to workout_editor.js
 * - Delegates per-set timers to set_timers.js (live-only)
 * - Delegates history paging/render to workout_history.js
 *
 * Heat-map behavior:
 * - Only COMPLETED sets are emitted to heat engine (via editor callback).
 */
export function createWorkoutUI({
  dom,
  apiJson,
  getExerciseById,
  computeStimulusSingleSet,
  historyPerPage = 5,

  // callbacks
  onEditorSetsChanged,          // (completedSetsOnly) => void
  onHeatAvailabilityChanged,    // ({ canWorkoutHeat: boolean }) => void
}) {
  if (!dom) throw new Error("createWorkoutUI missing dom");

  const {
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
  } = dom;

  /* ==============================
     State (owned here)
  ============================== */
  let activeWorkout = null;      // {id,...} or null
  let viewingWorkoutId = null;   // null => live view; else past workout
  let viewingSets = [];          // normalized sets currently shown in editor

  const pending = {
    dirty: false,
    updatesBySetId: new Map(), // setId -> {reps?, load_lbs?, completed?}
    deletes: new Set(),        // setId
  };

  let workoutTimerStartedAtMs = 0;

  // prefs map (exercise_id -> prefs)
  // prefs: { timer_enabled: bool, timer_secs: int }
  const prefsByExercise = new Map();

  /* ==============================
     Internal helpers
  ============================== */
  function setControlsEnabled(enabled) {
    if (!workControls) return;
    if (enabled) workControls.classList.remove("disabled");
    else workControls.classList.add("disabled");
  }

  function clearPending() {
    pending.dirty = false;
    pending.updatesBySetId.clear();
    pending.deletes.clear();
    updateSaveFooterState();
  }

  function markPendingDirty() {
    pending.dirty = true;
  }

  function updateSaveFooterState() {
    if (!editorFooter) return;
    if (!viewingWorkoutId) {
      editorFooter.classList.add("hidden");
      return;
    }
    editorFooter.classList.remove("hidden");
    if (saveEditBtn) saveEditBtn.disabled = !pending.dirty;
  }

  function setHeatButtonsUi(getHeatMode) {
    const heatMode = getHeatMode?.() || "overall";
    if (heatOverallBtn) heatOverallBtn.classList.toggle("on", heatMode === "overall");
    if (heatWorkoutBtn) heatWorkoutBtn.classList.toggle("on", heatMode === "workout");

    const canWorkoutHeat = Boolean(activeWorkout) || Boolean(viewingWorkoutId);
    if (heatWorkoutBtn) heatWorkoutBtn.disabled = !canWorkoutHeat;

    onHeatAvailabilityChanged?.({ canWorkoutHeat });
  }

  function setWorkoutHeaderUI() {
    const isEditingPast = Boolean(viewingWorkoutId);

    if (isEditingPast) {
      if (workTitle) workTitle.textContent = "Workout (edit past)";
      if (statusText) statusText.textContent = `Editing workout #${viewingWorkoutId}`;
      if (timerText) timerText.textContent = "—";
      if (startWorkoutBtn) startWorkoutBtn.disabled = true;
      if (endWorkoutBtn) endWorkoutBtn.disabled = true;
      setControlsEnabled(false);
      if (editorFooter) editorFooter.classList.remove("hidden");
      updateSaveFooterState();
      return;
    }

    if (editorFooter) editorFooter.classList.add("hidden");

    if (!activeWorkout) {
      if (workTitle) workTitle.textContent = "Workout";
      if (statusText) statusText.textContent = "No workout";
      if (timerText) timerText.textContent = "—";
      if (startWorkoutBtn) startWorkoutBtn.disabled = false;
      if (endWorkoutBtn) endWorkoutBtn.disabled = true;
      setControlsEnabled(false);
    } else {
      if (workTitle) workTitle.textContent = "Workout (live)";
      if (statusText) statusText.textContent = "In progress";
      if (startWorkoutBtn) startWorkoutBtn.disabled = true;
      if (endWorkoutBtn) endWorkoutBtn.disabled = false;
      setControlsEnabled(true);
    }
  }

  function getPrefs(exId) {
    const p = prefsByExercise.get(exId);
    if (p && typeof p === "object") return p;
    return { timer_enabled: true, timer_secs: 60 };
  }

  async function setPrefs(exId, prefsPatch) {
    const ex = String(exId || "").trim();
    if (!ex) return;

    const current = getPrefs(ex);
    const merged = { ...current, ...(prefsPatch || {}) };

    merged.timer_enabled = Boolean(merged.timer_enabled);
    merged.timer_secs = clampInt(Number(merged.timer_secs), 0, 3600);

    prefsByExercise.set(ex, merged);

    try {
      await apiJson(API.EXERCISE_PREFS_SET, {
        method: "POST",
        body: JSON.stringify({ exercise_key: ex, prefs: merged }),
      });
    } catch (e) {
      console.warn("[prefs] save failed", e);
    }
  }

  function findNextIncompleteSetRowInSameExercise(exId) {
    try {
      const card = workoutEditor?.querySelector(`.excard[data-exid="${CSS.escape(exId)}"]`);
      if (!card) return null;
      return card.querySelector(`.setrow[data-completed="0"]`);
    } catch {
      return null;
    }
  }

  function highlightRow(el) {
    if (!el) return;
    try {
      el.classList.add("pulse");
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      setTimeout(() => el.classList.remove("pulse"), 1000);
    } catch {}
  }

  /* ==============================
     Sub-modules
  ============================== */
  const timers = createSetTimerManager({
    workoutEditor,
    getPrefs,
    isEditingPast: () => Boolean(viewingWorkoutId),
    getViewingSets: () => viewingSets,
    findNextIncompleteRowInExercise: (exId) => findNextIncompleteSetRowInSameExercise(exId),
    highlightRow,
  });

  const editor = createWorkoutEditor({
    dom: { workoutEditor, exerciseSelect },
    apiJson,
    API,
    getExerciseById,
    computeStimulusSingleSet,

    getPrefs,
    setPrefs,

    getActiveWorkout: () => activeWorkout,
    getViewingWorkoutId: () => viewingWorkoutId,
    getViewingSets: () => viewingSets,
    setViewingSets: (sets) => { viewingSets = sets; },

    pending,
    clearPending,
    markPendingDirty,
    updateSaveFooterState,

    onSetsChanged: (completedSetsOnly) => onEditorSetsChanged?.(completedSetsOnly),

    onAfterLiveMutation: async () => {
      // after add/update/delete in live mode:
      // - reload sets (so IDs, order, server truth)
      // - refresh history
      await loadCurrentWorkoutSets();
      await history.refreshHistory();
    },

    timers,
  });

  const history = createWorkoutHistory({
    dom: { historyBox, prevPageBtn, nextPageBtn, pageHint },
    apiJson,
    API,
    historyPerPage,

    getActiveWorkout: () => activeWorkout,
    getViewingWorkoutId: () => viewingWorkoutId,

    onSelectWorkout: async (wid) => {
      await viewWorkout(wid);
    },
  });

  /* ==============================
     API loaders
  ============================== */
  async function refreshStatus() {
    const data = await apiJson(API.WORKOUT_STATUS, { method: "GET" });
    activeWorkout = data.active || null;

    if (activeWorkout?.started_at) {
      const d = parseSqlDateTime(activeWorkout.started_at);
      workoutTimerStartedAtMs = d ? d.getTime() : 0;
    } else {
      workoutTimerStartedAtMs = 0;
    }
  }

  async function loadPrefsFromServer() {
    try {
      const data = await apiJson(API.EXERCISE_PREFS_GET, { method: "GET" });
      const map = (data && data.map && typeof data.map === "object") ? data.map : {};
      prefsByExercise.clear();
      for (const [exId, prefs] of Object.entries(map)) {
        if (!exId) continue;
        if (!prefs || typeof prefs !== "object") continue;
        const norm = {
          timer_enabled: Boolean(prefs.timer_enabled ?? true),
          timer_secs: clampInt(Number(prefs.timer_secs ?? 60), 0, 3600),
        };
        prefsByExercise.set(String(exId), norm);
      }
    } catch (e) {
      console.warn("[prefs] load failed:", e);
    }
  }

  async function loadCurrentWorkoutSets() {
    const data = await apiJson(API.WORKOUT_GET_CURRENT, { method: "GET" });

    activeWorkout = data.active || null;
    viewingWorkoutId = null;
    clearPending();

    viewingSets = Array.isArray(data.sets) ? data.sets.map(editor.normalizeSetRow) : [];

    // cleanup timer states for sets that no longer exist
    timers.cleanupNotAlive(viewingSets.map((s) => Number(s.id)));

    if (activeWorkout?.started_at) {
      const d = parseSqlDateTime(activeWorkout.started_at);
      workoutTimerStartedAtMs = d ? d.getTime() : 0;
    } else {
      workoutTimerStartedAtMs = 0;
    }

    setWorkoutHeaderUI();
    editor.render();
    editor.emitSetsChanged();
  }

  async function viewWorkout(workoutId) {
    const wid = Number(workoutId);
    if (!wid) return;

    const data = await apiJson(`${API.WORKOUT_GET_ONE}?id=${wid}`, { method: "GET" });

    viewingWorkoutId = wid;
    clearPending();

    viewingSets = Array.isArray(data.sets) ? data.sets.map(editor.normalizeSetRow) : [];

    setWorkoutHeaderUI();
    editor.render();
    editor.emitSetsChanged();
  }

  async function exitPastWorkoutEdit() {
    viewingWorkoutId = null;
    clearPending();
    await loadCurrentWorkoutSets();
  }

  /* ==============================
     Actions: start/end/add
  ============================== */
  async function startWorkout() {
    await apiJson(API.WORKOUT_START, { method: "POST" }).catch(async () => {
      return await apiJson(API.WORKOUT_START, { method: "GET" });
    });

    await loadCurrentWorkoutSets();
    await history.refreshHistory();
  }

  async function endWorkout() {
    if (!activeWorkout) return;
    if (!confirm("End workout?")) return;

    await apiJson(API.WORKOUT_END, { method: "POST" }).catch(async () => {
      return await apiJson(API.WORKOUT_END, { method: "GET" });
    });

    await refreshStatus();
    await loadCurrentWorkoutSets();
    await history.refreshHistory();
  }

  async function addExerciseAsOneSet() {
    if (!activeWorkout) return;

    const exId = String(exerciseSelect.value || "").trim();
    if (!exId) return;

    const ex = await getExerciseById(exId);
    if (!ex) return;

    // We always use the CURRENT exercise weights from the exercise catalog
    // (not whatever was stored in old set rows), so updates to exercise mapping apply.
    const muscles = {};
    for (const [gid, w] of Object.entries(ex.w || {})) {
      const ww = Number(w);
      if (!Number.isFinite(ww) || ww <= 0) continue;
      muscles[gid] = ww;
    }

    // Pull last sets for this exercise from the last workout that used it.
    // If anything fails / none found => fallback to one default set.
    let lastSets = [];
    try {
      const data = await apiJson(
        `${API.LAST_SETS_FOR_EX}?exercise_id=${encodeURIComponent(ex.id)}`,
        { method: "GET" }
      );
      lastSets = Array.isArray(data?.sets) ? data.sets : [];
    } catch (e) {
      console.warn("[memory] get_last_sets_for_exercise failed:", e);
      lastSets = [];
    }

    // Normalize what we’ll re-create
    const toCreate = (lastSets.length ? lastSets : [{ reps: 10, load_lbs: null }])
      .slice(0, 20)
      .map((s) => {
        const reps = Math.max(1, parseInt(String(s?.reps ?? 10), 10) || 10);
        const load = (s?.load_lbs === null || s?.load_lbs === undefined || s?.load_lbs === "")
          ? null
          : Math.max(0, Number(s.load_lbs));
        return { reps, load_lbs: Number.isFinite(load) ? load : null };
      });

    // Create sets sequentially to preserve order and keep server load predictable.
    for (const s of toCreate) {
      const stim = computeStimulusSingleSet(s.reps, s.load_lbs);

      await apiJson(API.WORKOUT_ADD_SET, {
        method: "POST",
        body: JSON.stringify({
          exercise_id: ex.id,
          exercise_name: ex.name,
          reps: s.reps,
          load_lbs: s.load_lbs,
          stimulus: stim,
          completed: 0,      // IMPORTANT: reset checkmarks
          muscles,           // IMPORTANT: use current mapping
        }),
      });
    }

    await loadCurrentWorkoutSets();
    await history.refreshHistory();
  }


  /* ==============================
     Save past edits (still owned here)
  ============================== */
  async function savePastEdits() {
    if (!viewingWorkoutId) return;
    if (!pending.dirty) return;

    if (!confirm("Save changes to this workout?")) return;

    for (const setId of pending.deletes) {
      await apiJson(API.WORKOUT_DELETE_SET, {
        method: "POST",
        body: JSON.stringify({ set_id: setId }),
      });
    }

    for (const [setId, patch] of pending.updatesBySetId.entries()) {
      const body = { set_id: setId };

      if (patch.reps !== undefined) body.reps = Math.max(1, parseInt(String(patch.reps ?? 1), 10));
      if (patch.load_lbs !== undefined) {
        const load = (patch.load_lbs === null || patch.load_lbs === undefined)
          ? null
          : Math.max(0, Number(patch.load_lbs));
        body.load_lbs = load;
      }
      if (patch.completed !== undefined) body.completed = patch.completed ? 1 : 0;

      const current = viewingSets.find((s) => Number(s.id) === setId);
      const reps = (body.reps !== undefined) ? body.reps : (current?.reps ?? 1);
      const load = (body.load_lbs !== undefined) ? body.load_lbs : (current?.load_lbs ?? null);
      body.stimulus = computeStimulusSingleSet(reps, load);

      await apiJson(API.WORKOUT_UPDATE_SET, {
        method: "POST",
        body: JSON.stringify(body),
      });
    }

    clearPending();

    await viewWorkout(viewingWorkoutId);
    await history.refreshHistory();
  }

  /* ==============================
     Public getters
  ============================== */
  function getActiveWorkout() { return activeWorkout; }
  function getViewingWorkoutId() { return viewingWorkoutId; }
  function getViewingSets() { return viewingSets; }
  function canWorkoutHeat() { return Boolean(activeWorkout) || Boolean(viewingWorkoutId); }

  /* ==============================
     Timer (workout duration) + per-set timers
  ============================== */
  function tickTimer(now = Date.now()) {
    // tick per-set timers + refresh their UI (live-only)
    if (workoutEditor && !viewingWorkoutId) {
      timers.tick(now);
      timers.updateAllVisibleUIs();
    }

    if (!timerText) return;

    if (viewingWorkoutId) {
      timerText.textContent = "—";
      return;
    }

    if (!activeWorkout || !workoutTimerStartedAtMs) {
      timerText.textContent = "—";
      return;
    }

    timerText.textContent = fmtElapsed(now - workoutTimerStartedAtMs);
  }

  /* ==============================
     Wiring (buttons)
  ============================== */
  function wire() {
    if (startWorkoutBtn) {
      startWorkoutBtn.addEventListener("click", async () => {
        try {
          await startWorkout();
          setWorkoutHeaderUI();
          setHeatButtonsUi(dom.getHeatMode);
        } catch (e) {
          console.error(e);
          alert(e?.message || "Failed to start workout.");
        }
      });
    }

    if (endWorkoutBtn) {
      endWorkoutBtn.addEventListener("click", async () => {
        try {
          await endWorkout();
          setWorkoutHeaderUI();
          setHeatButtonsUi(dom.getHeatMode);
        } catch (e) {
          console.error(e);
          alert(e?.message || "Failed to end workout.");
        }
      });
    }

    if (addExerciseBtn) {
      addExerciseBtn.addEventListener("click", async () => {
        try {
          await addExerciseAsOneSet();
          setWorkoutHeaderUI();
          setHeatButtonsUi(dom.getHeatMode);
        } catch (e) {
          console.error(e);
          alert(e?.message || "Failed to add exercise.");
        }
      });
    }

    if (discardEditBtn) {
      discardEditBtn.addEventListener("click", async () => {
        try {
          if (!viewingWorkoutId) return;
          if (pending.dirty && !confirm("Discard changes?")) return;
          await exitPastWorkoutEdit();
          await history.refreshHistory();
          setWorkoutHeaderUI();
          setHeatButtonsUi(dom.getHeatMode);
        } catch (e) {
          console.error(e);
          alert(e?.message || "Failed to exit editor.");
        }
      });
    }

    if (saveEditBtn) {
      saveEditBtn.addEventListener("click", async () => {
        try {
          await savePastEdits();
          setWorkoutHeaderUI();
          setHeatButtonsUi(dom.getHeatMode);
        } catch (e) {
          console.error(e);
          alert(e?.message || "Failed to save changes.");
        }
      });
    }

    if (prevPageBtn) {
      prevPageBtn.addEventListener("click", async () => {
        try {
          await history.goPrev();
        } catch (e) {
          console.error(e);
          alert(e?.message || "Failed to load history.");
        }
      });
    }

    if (nextPageBtn) {
      nextPageBtn.addEventListener("click", async () => {
        try {
          await history.goNext();
        } catch (e) {
          console.error(e);
          alert(e?.message || "Failed to load history.");
        }
      });
    }
  }

  /* ==============================
     Boot
  ============================== */
  async function boot() {
    await loadPrefsFromServer().catch(() => {});
    await refreshStatus().catch(() => { activeWorkout = null; });

    if (activeWorkout) {
      await loadCurrentWorkoutSets().catch(() => {
        activeWorkout = null;
        viewingWorkoutId = null;
        viewingSets = [];
        clearPending();
        setWorkoutHeaderUI();
        editor.render();
        editor.emitSetsChanged();
      });
    } else {
      viewingWorkoutId = null;
      viewingSets = [];
      clearPending();
      setWorkoutHeaderUI();
      editor.render();
      editor.emitSetsChanged();
    }

    await history.refreshHistory().catch(() => {});
  }

  // immediate wire-up
  wire();

  return {
    boot,
    refreshStatus,
    refreshHistory: history.refreshHistory,
    loadCurrentWorkoutSets,

    viewWorkout,
    exitPastWorkoutEdit,
    savePastEdits,

    startWorkout,
    endWorkout,
    addExerciseAsOneSet,

    tickTimer,
    setWorkoutHeaderUI,
    setHeatButtonsUi,

    getActiveWorkout,
    getViewingWorkoutId,
    getViewingSets,
    canWorkoutHeat,

    // expose paging if needed
    getHistoryPage: () => history.getHistoryPage(),
    getHistoryPages: () => history.getHistoryPages(),

    // prefs setter for future UI
    setPrefs,
  };
}
