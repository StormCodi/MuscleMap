// lib/workout_ui.js
import { API } from "./api.js";

/* ==============================
   Utils
============================== */
function parseSqlDateTime(s) {
  if (!s) return null;
  const iso = String(s).replace(" ", "T");
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtElapsed(ms) {
  if (!(ms >= 0)) return "—";
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (hh > 0) return `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  return `${mm}:${String(ss).padStart(2, "0")}`;
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

function fmtWorkoutDate(s) {
  const d = parseSqlDateTime(s);
  if (!d) return String(s || "");
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

/* ==============================
   Builder
============================== */
/**
 * Workout UI module:
 * - Owns workout/past-edit state, editor rendering, history rendering, workout CRUD.
 * - Does NOT own heat visuals; it emits changes via callbacks so main can rebuild heat.
 */
export function createWorkoutUI({
  dom,
  apiJson,
  getExerciseById,
  computeStimulusSingleSet,
  historyPerPage = 5,

  // callbacks
  onEditorSetsChanged,          // (viewingSets) => void
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
  let viewingSets = [];          // sets currently shown in editor (live or past)

  let historyPage = 1;
  let historyPages = 1;

  const pending = {
    dirty: false,
    updatesBySetId: new Map(), // setId -> {reps?, load_lbs?}
    deletes: new Set(),        // setId
  };

  let workoutTimerStartedAtMs = 0;

  /* ==============================
     Internal helpers
  ============================== */
  function normalizeSetRow(s) {
    return {
      id: Number(s.id),
      workout_id: Number(s.workout_id),
      exercise_id: String(s.exercise_id),
      exercise_name: String(s.exercise_name),
      reps: Number(s.reps),
      load_lbs: (s.load_lbs === null || s.load_lbs === undefined) ? null : Number(s.load_lbs),
      stimulus: Number(s.stimulus),
      muscles: (s.muscles && typeof s.muscles === "object") ? s.muscles : null,
      created_at: String(s.created_at || ""),
      updated_at: String(s.updated_at || ""),
    };
  }

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

  function groupSetsByExercise(sets) {
    const map = new Map(); // exId -> {exercise_id, exercise_name, sets:[]}
    for (const s of sets) {
      const exId = String(s.exercise_id);
      if (!map.has(exId)) {
        map.set(exId, {
          exercise_id: exId,
          exercise_name: String(s.exercise_name || exId),
          sets: [],
        });
      }
      map.get(exId).sets.push(s);
    }
    return [...map.values()];
  }

  function renderWorkoutEditor() {
    if (!workoutEditor) return;

    if (!viewingSets.length) {
      if (viewingWorkoutId) {
        workoutEditor.innerHTML = `<div class="muted">No sets in this workout.</div>`;
      } else if (!activeWorkout) {
        workoutEditor.innerHTML = `<div class="muted">Start a workout to add exercises.</div>`;
      } else {
        workoutEditor.innerHTML = `<div class="muted">Add an exercise to begin.</div>`;
      }
      return;
    }

    const groups = groupSetsByExercise(viewingSets);

    workoutEditor.innerHTML = groups.map((g) => {
      const setsHtml = g.sets.map((s) => {
        const loadVal = (s.load_lbs === null || s.load_lbs === undefined) ? "" : String(s.load_lbs);

        return `
          <div class="setrow" data-setid="${escapeHtml(s.id)}">
            <input class="repsInput" inputmode="numeric" value="${escapeHtml(s.reps)}" />
            <input class="loadInput" inputmode="decimal" placeholder="lbs" value="${escapeHtml(loadVal)}" />
            <button class="iconbtn bad delSetBtn" type="button" title="Delete set">×</button>
          </div>
        `;
      }).join("");

      return `
        <div class="excard" data-exid="${escapeHtml(g.exercise_id)}">
          <div class="excard-top">
            <div>
              <div class="ex-name">${escapeHtml(g.exercise_name)}</div>
              <div class="ex-sub">${escapeHtml(g.exercise_id)}</div>
            </div>
          </div>
          <div class="sets">
            ${setsHtml}
          </div>
        </div>
      `;
    }).join("");

    wireEditorInteractions();
  }

  function wireEditorInteractions() {
    const rows = workoutEditor.querySelectorAll(".setrow");
    rows.forEach((row) => {
      const setId = Number(row.getAttribute("data-setid"));
      if (!setId) return;

      const repsEl = row.querySelector(".repsInput");
      const loadEl = row.querySelector(".loadInput");
      const delBtn = row.querySelector(".delSetBtn");

      const onChange = async () => {
        const reps = Math.max(1, parseInt(String(repsEl.value || "1"), 10));
        const loadStr = String(loadEl.value || "").trim();
        const load = loadStr === "" ? null : Math.max(0, Number(loadStr));

        // update local view immediately
        const idx = viewingSets.findIndex((s) => Number(s.id) === setId);
        if (idx >= 0) {
          viewingSets[idx].reps = reps;
          viewingSets[idx].load_lbs = load;
          viewingSets[idx].stimulus = computeStimulusSingleSet(reps, load);
        }

        // notify heat engine (workout mode uses viewingSets)
        onEditorSetsChanged?.(viewingSets);

        if (viewingWorkoutId) {
          pending.dirty = true;
          pending.updatesBySetId.set(setId, { reps, load_lbs: load });
          updateSaveFooterState();
          return;
        }

        // live: update immediately
        const stim = computeStimulusSingleSet(reps, load);
        await apiJson(API.WORKOUT_UPDATE_SET, {
          method: "POST",
          body: JSON.stringify({ set_id: setId, reps, load_lbs: load, stimulus: stim }),
        });

        // refresh history so counts/summary update
        await refreshHistory();
      };

      repsEl?.addEventListener("change", () => { onChange().catch(() => {}); });
      loadEl?.addEventListener("change", () => { onChange().catch(() => {}); });

      delBtn?.addEventListener("click", async () => {
        if (!confirm("Delete this set?")) return;

        // local remove
        viewingSets = viewingSets.filter((s) => Number(s.id) !== setId);
        renderWorkoutEditor();
        onEditorSetsChanged?.(viewingSets);

        if (viewingWorkoutId) {
          pending.dirty = true;
          pending.deletes.add(setId);
          pending.updatesBySetId.delete(setId);
          updateSaveFooterState();
          return;
        }

        await apiJson(API.WORKOUT_DELETE_SET, {
          method: "POST",
          body: JSON.stringify({ set_id: setId }),
        });

        await refreshHistory();
      });
    });
  }

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

  async function loadCurrentWorkoutSets() {
    const data = await apiJson(API.WORKOUT_GET_CURRENT, { method: "GET" });

    activeWorkout = data.active || null;
    viewingWorkoutId = null;
    clearPending();

    viewingSets = Array.isArray(data.sets) ? data.sets.map(normalizeSetRow) : [];

    if (activeWorkout?.started_at) {
      const d = parseSqlDateTime(activeWorkout.started_at);
      workoutTimerStartedAtMs = d ? d.getTime() : 0;
    } else {
      workoutTimerStartedAtMs = 0;
    }

    setWorkoutHeaderUI();
    renderWorkoutEditor();

    onEditorSetsChanged?.(viewingSets);
  }

  async function viewWorkout(workoutId) {
    const wid = Number(workoutId);
    if (!wid) return;

    const data = await apiJson(`${API.WORKOUT_GET_ONE}?id=${wid}`, { method: "GET" });

    viewingWorkoutId = wid;
    clearPending();

    viewingSets = Array.isArray(data.sets) ? data.sets.map(normalizeSetRow) : [];

    setWorkoutHeaderUI();
    renderWorkoutEditor();

    onEditorSetsChanged?.(viewingSets);
  }

  async function exitPastWorkoutEdit() {
    viewingWorkoutId = null;
    clearPending();
    await loadCurrentWorkoutSets();
  }

  /* ==============================
     History + paging
  ============================== */
  async function refreshHistory() {
    const data = await apiJson(`${API.WORKOUT_LIST}?page=${historyPage}&per=${historyPerPage}`, { method: "GET" });
    const workouts = Array.isArray(data.workouts) ? data.workouts : [];

    historyPages = Number(data.pages) || 1;
    historyPage = Number(data.page) || 1;

    if (prevPageBtn) prevPageBtn.disabled = historyPage <= 1;
    if (nextPageBtn) nextPageBtn.disabled = historyPage >= historyPages;

    if (pageHint) pageHint.textContent = historyPages > 1 ? `Page ${historyPage} / ${historyPages}` : "";

    historyBox.innerHTML = workouts.map((w) => {
      const isLive = activeWorkout && Number(activeWorkout.id) === Number(w.id);
      const isViewing = viewingWorkoutId && Number(viewingWorkoutId) === Number(w.id);

      const badge = isLive
        ? `<span class="badge live">LIVE</span>`
        : isViewing
          ? `<span class="badge">EDITING</span>`
          : "";

      const sum = w.summary || {};
      const setsCount = Number(sum.sets_count ?? 0);
      const exCount = Number(sum.exercises_count ?? 0);
      const meta = `${exCount} exercises • ${setsCount} sets`;

      return `
        <div class="workcard" data-wid="${escapeHtml(w.id)}">
          <div class="workcard-top">
            <div>
              <div class="workcard-title">Workout #${escapeHtml(w.id)}</div>
              <div class="workcard-meta">${escapeHtml(fmtWorkoutDate(w.started_at))}${w.ended_at ? ` → ${escapeHtml(fmtWorkoutDate(w.ended_at))}` : ""}</div>
              <div class="workcard-meta">${escapeHtml(meta)}</div>
            </div>
            ${badge}
          </div>
        </div>
      `;
    }).join("") || `<div class="muted">No workouts yet.</div>`;

    historyBox.querySelectorAll(".workcard").forEach((el) => {
      el.addEventListener("click", async () => {
        const wid = Number(el.getAttribute("data-wid"));
        if (!wid) return;

        if (viewingWorkoutId && Number(viewingWorkoutId) === wid) return;

        await viewWorkout(wid);
        await refreshHistory();
      });
    });
  }

  /* ==============================
     Actions: start/end/add
  ============================== */
  async function startWorkout() {
    await apiJson(API.WORKOUT_START, { method: "POST" }).catch(async () => {
      return await apiJson(API.WORKOUT_START, { method: "GET" });
    });

    await loadCurrentWorkoutSets();
    await refreshHistory();
  }

  async function endWorkout() {
    if (!activeWorkout) return;
    if (!confirm("End workout?")) return;

    await apiJson(API.WORKOUT_END, { method: "POST" }).catch(async () => {
      return await apiJson(API.WORKOUT_END, { method: "GET" });
    });

    await refreshStatus();
    await loadCurrentWorkoutSets();
    await refreshHistory();
  }

  async function addExerciseAsOneSet() {
    if (!activeWorkout) return;

    const exId = String(exerciseSelect.value || "").trim();
    if (!exId) return;

    const ex = await getExerciseById(exId);
    if (!ex) return;

    const reps = 10;
    const load = null;
    const stim = computeStimulusSingleSet(reps, load);

    const muscles = {};
    for (const [gid, w] of Object.entries(ex.w || {})) {
      const ww = Number(w);
      if (!Number.isFinite(ww) || ww <= 0) continue;
      muscles[gid] = ww;
    }

    await apiJson(API.WORKOUT_ADD_SET, {
      method: "POST",
      body: JSON.stringify({
        exercise_id: ex.id,
        exercise_name: ex.name,
        reps,
        load_lbs: load,
        stimulus: stim,
        muscles,
      }),
    });

    await loadCurrentWorkoutSets();
    await refreshHistory();
  }

  /* ==============================
     Save past edits
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
      const reps = Math.max(1, parseInt(String(patch.reps ?? 1), 10));
      const load = (patch.load_lbs === null || patch.load_lbs === undefined) ? null : Math.max(0, Number(patch.load_lbs));
      const stim = computeStimulusSingleSet(reps, load);

      await apiJson(API.WORKOUT_UPDATE_SET, {
        method: "POST",
        body: JSON.stringify({ set_id: setId, reps, load_lbs: load, stimulus: stim }),
      });
    }

    clearPending();

    await viewWorkout(viewingWorkoutId);
    await refreshHistory();
  }

  /* ==============================
     Public getters
  ============================== */
  function getActiveWorkout() {
    return activeWorkout;
  }
  function getViewingWorkoutId() {
    return viewingWorkoutId;
  }
  function getViewingSets() {
    return viewingSets;
  }
  function canWorkoutHeat() {
    return Boolean(activeWorkout) || Boolean(viewingWorkoutId);
  }

  /* ==============================
     Timer
  ============================== */
  function tickTimer(now = Date.now()) {
    if (!timerText) return;

    if (viewingWorkoutId) {
      timerText.textContent = "—";
      return;
    }

    if (!activeWorkout || !workoutTimerStartedAtMs) {
      timerText.textContent = "—";
      return;
    }

    const ms = now - workoutTimerStartedAtMs;
    timerText.textContent = fmtElapsed(ms);
  }

  /* ==============================
     Wiring (buttons that belong to workout domain)
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
          await refreshHistory();
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
        if (historyPage <= 1) return;
        historyPage--;
        try {
          await refreshHistory();
        } catch (e) {
          console.error(e);
          alert(e?.message || "Failed to load history.");
        }
      });
    }

    if (nextPageBtn) {
      nextPageBtn.addEventListener("click", async () => {
        if (historyPage >= historyPages) return;
        historyPage++;
        try {
          await refreshHistory();
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
    await refreshStatus().catch(() => { activeWorkout = null; });

    if (activeWorkout) {
      await loadCurrentWorkoutSets().catch(() => {
        activeWorkout = null;
        viewingWorkoutId = null;
        viewingSets = [];
        clearPending();
        setWorkoutHeaderUI();
        renderWorkoutEditor();
        onEditorSetsChanged?.(viewingSets);
      });
    } else {
      viewingWorkoutId = null;
      viewingSets = [];
      clearPending();
      setWorkoutHeaderUI();
      renderWorkoutEditor();
      onEditorSetsChanged?.(viewingSets);
    }

    await refreshHistory().catch(() => {});
  }

  // immediate wire-up
  wire();

  return {
    boot,
    refreshStatus,
    refreshHistory,
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
    getHistoryPage: () => historyPage,
    getHistoryPages: () => historyPages,
  };
}
