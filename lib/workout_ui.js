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

// title formatter for history cards
function fmtWorkoutTitle(s) {
  const d = parseSqlDateTime(s);
  if (!d) return "Workout";

  const out = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);

  return out.replace(/,/, "");
}

function clampInt(n, lo, hi) {
  n = Number.isFinite(n) ? Math.trunc(n) : lo;
  return Math.max(lo, Math.min(hi, n));
}

function fmtMMSS(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

/* ==============================
   Builder
============================== */
/**
 * Workout UI module:
 * - Owns workout/past-edit state, editor rendering, history rendering, workout CRUD.
 * - Does NOT own heat visuals; it emits changes via callbacks so main can rebuild heat.
 *
 * Timer system (Per-Set):
 * - Each set row has a timer bar directly under it.
 * - Checking a set starts that set’s timer (using per-exercise prefs.timer_secs).
 * - Bar shrinks like a loading indicator.
 * - Pause/unpause supported.
 * - X disables the timer (greys out) with a button to re-enable.
 * - On completion: vibrate (if supported) + highlight next incomplete set in the same exercise.
 * - Timers are LIVE-only (not when editing past workouts).
 *
 * Prefs (server-backed):
 * - api/exercise_prefs.php stores per-exercise {timer_enabled, timer_secs}
 *
 * Heat-map behavior (NEW):
 * - Only COMPLETED sets are emitted to heat engine.
 */
export function createWorkoutUI({
  dom,
  apiJson,
  getExerciseById,
  computeStimulusSingleSet,
  historyPerPage = 5,

  // callbacks
  onEditorSetsChanged,          // (viewingSetsOrFilteredSets) => void
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
    updatesBySetId: new Map(), // setId -> {reps?, load_lbs?, completed?}
    deletes: new Set(),        // setId
  };

  let workoutTimerStartedAtMs = 0;

  // prefs map (exercise_id -> prefs)
  // prefs: { timer_enabled: bool, timer_secs: int }
  const prefsByExercise = new Map();

  // Per-set timer runtime state (client-only)
  // setId -> {
  //   disabled: bool,
  //   running: bool,
  //   paused: bool,
  //   totalSec: number,
  //   endAtMs: number,
  //   remainingSec: number,
  //   pausedRemainingSec: number,
  //   doneVibrated: bool,
  // }
  const setTimers = new Map();

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
      completed: Number(s.completed || 0) ? 1 : 0,
      muscles: (s.muscles && typeof s.muscles === "object") ? s.muscles : null,
      created_at: String(s.created_at || ""),
      updated_at: String(s.updated_at || ""),
    };
  }

  // NEW: only completed sets should affect workout heat
  function getHeatRelevantSets() {
    return viewingSets.filter((s) => Number(s.completed) === 1);
  }

  function emitEditorSetsChanged() {
    onEditorSetsChanged?.(getHeatRelevantSets());
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

  function getPrefs(exId) {
    const p = prefsByExercise.get(exId);
    if (p && typeof p === "object") return p;
    return { timer_enabled: true, timer_secs: 60 };
  }

  async function setPrefs(exId, prefsPatch) {
    const ex = String(exId || "").trim();
    if (!ex) return;

    const current = getPrefs(ex);
    const merged = {
      ...current,
      ...(prefsPatch || {}),
    };

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

  function safeVibrate(ms = 200) {
    try {
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        navigator.vibrate(ms);
      }
    } catch {}
  }

  function getSetTimerState(setId) {
    const t = setTimers.get(setId);
    if (t && typeof t === "object") return t;
    return null;
  }

  function ensureSetTimerState(setId) {
    const existing = getSetTimerState(setId);
    if (existing) return existing;

    const t = {
      disabled: false,
      running: false,
      paused: false,
      totalSec: 0,
      endAtMs: 0,
      remainingSec: 0,
      pausedRemainingSec: 0,
      doneVibrated: false,
    };
    setTimers.set(setId, t);
    return t;
  }

  function stopSetTimer(setId) {
    const t = getSetTimerState(setId);
    if (!t) return;
    t.running = false;
    t.paused = false;
    t.totalSec = 0;
    t.endAtMs = 0;
    t.remainingSec = 0;
    t.pausedRemainingSec = 0;
    t.doneVibrated = false;
  }

  function disableSetTimer(setId) {
    const t = ensureSetTimerState(setId);
    t.disabled = true;
    stopSetTimer(setId);
  }

  function enableSetTimer(setId) {
    const t = ensureSetTimerState(setId);
    t.disabled = false;
    // do not auto-start here; starting is driven by checkbox change
  }

  function startSetTimerFor(setRow, seconds) {
    if (!setRow) return;
    const setId = Number(setRow.id);
    if (!setId) return;

    const t = ensureSetTimerState(setId);
    if (t.disabled) return;

    const secs = clampInt(Number(seconds), 0, 3600);
    if (secs <= 0) {
      stopSetTimer(setId);
      return;
    }

    const now = Date.now();
    t.running = true;
    t.paused = false;
    t.totalSec = secs;
    t.remainingSec = secs;
    t.endAtMs = now + secs * 1000;
    t.pausedRemainingSec = 0;
    t.doneVibrated = false;
  }

  function togglePauseSetTimer(setId) {
    const t = getSetTimerState(setId);
    if (!t || t.disabled) return;

    if (!t.running && !t.paused) return; // nothing to pause
    if (t.running) {
      // pause
      const now = Date.now();
      t.remainingSec = Math.max(0, Math.ceil((t.endAtMs - now) / 1000));
      t.pausedRemainingSec = t.remainingSec;
      t.running = false;
      t.paused = true;
    } else if (t.paused) {
      // resume
      const now = Date.now();
      const rem = clampInt(Number(t.pausedRemainingSec), 0, 3600);
      if (rem <= 0) {
        t.paused = false;
        stopSetTimer(setId);
        return;
      }
      t.running = true;
      t.paused = false;
      t.remainingSec = rem;
      t.endAtMs = now + rem * 1000;
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

  function updateSetTimerUIForRow(rowEl, setId) {
    if (!rowEl) return;

    const t = getSetTimerState(setId);
    const bar = rowEl.querySelector(".setTimerBar");
    const fill = rowEl.querySelector(".setTimerFill");
    const txt = rowEl.querySelector(".setTimerText");
    const pauseBtn = rowEl.querySelector(".setTimerPauseBtn");
    const disableBtn = rowEl.querySelector(".setTimerDisableBtn");
    const enableBtn = rowEl.querySelector(".setTimerEnableBtn");

    const completed = String(rowEl.getAttribute("data-completed") || "0") === "1";

    const disabled = Boolean(t && t.disabled);
    const paused = Boolean(t && t.paused);
    const running = Boolean(t && t.running);
    const total = Number(t && t.totalSec) || 0;
    const remaining = Number(t && t.remainingSec) || 0;

    // base visual states
    bar?.classList.toggle("disabled", disabled);
    bar?.classList.toggle("paused", paused);

    if (enableBtn) enableBtn.classList.toggle("hidden", !disabled);
    if (pauseBtn) pauseBtn.classList.toggle("hidden", disabled);
    if (disableBtn) disableBtn.classList.toggle("hidden", disabled);

    // if not completed, bar should look idle (full) unless disabled
    let pct = 100;
    let label = "";

    if (disabled) {
      pct = 100;
      label = "Off";
    } else if (!completed) {
      pct = 100;
      label = "";
    } else {
      // completed
      if (total > 0) {
        pct = Math.max(0, Math.min(100, (remaining / total) * 100));
      } else {
        pct = running || paused ? 100 : 0;
      }

      if (running || paused) {
        label = fmtMMSS(remaining);
      } else if (total > 0 && remaining <= 0) {
        label = "Done";
      } else {
        label = "";
      }
    }

    if (fill) fill.style.width = `${pct}%`;
    if (txt) txt.textContent = label;

    if (pauseBtn) {
      pauseBtn.textContent = paused ? "▶" : "⏸";
      pauseBtn.disabled = !(completed && (running || paused));
    }
  }

  function tickSetTimers(now) {
    // Live-only timers. If editing past workouts, do not tick.
    if (viewingWorkoutId) return;

    for (const [setId, t] of setTimers.entries()) {
      if (!t || t.disabled) continue;
      if (!t.running) continue;

      const remaining = Math.ceil((t.endAtMs - now) / 1000);
      t.remainingSec = Math.max(0, remaining);

      if (t.remainingSec <= 0) {
        t.running = false;
        t.paused = false;

        // vibrate once
        if (!t.doneVibrated) {
          t.doneVibrated = true;
          safeVibrate(200);
        }

        // highlight next incomplete set in same exercise
        const set = viewingSets.find((s) => Number(s.id) === Number(setId));
        const exId = String(set?.exercise_id || "");
        if (exId) {
          const nextRow = findNextIncompleteSetRowInSameExercise(exId);
          if (nextRow) highlightRow(nextRow);
        }
      }
    }
  }

  function updateAllVisibleTimerUIs() {
    if (!workoutEditor) return;
    workoutEditor.querySelectorAll(".setrow").forEach((rowEl) => {
      const setId = Number(rowEl.getAttribute("data-setid") || "0");
      if (!setId) return;
      updateSetTimerUIForRow(rowEl, setId);
    });
  }

  /* ==============================
     Rendering
  ============================== */
  let __stylesInjected = false;
  function ensureInlineStylesOnce() {
    if (__stylesInjected) return;
    __stylesInjected = true;

    // keep very small "just in case" helpers; real styling is in style.css
    const css = `
      .pulse { outline:2px solid rgba(255,255,255,0.45); border-radius:10px; }
      .hidden { display:none !important; }
    `.trim();

    try {
      const st = document.createElement("style");
      st.textContent = css;
      document.head.appendChild(st);
    } catch {}
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
      const prefs = getPrefs(g.exercise_id);

      const setsHtml = g.sets.map((s) => {
        const loadVal = (s.load_lbs === null || s.load_lbs === undefined) ? "" : String(s.load_lbs);
        const checked = s.completed ? "checked" : "";

        // ensure timer state exists so UI can reflect disabled/paused etc
        ensureSetTimerState(Number(s.id));

        return `
          <div class="setrow ${s.completed ? "done" : ""}" data-setid="${escapeHtml(s.id)}" data-completed="${s.completed ? "1" : "0"}">
            <div class="setmain">
              <label class="chk">
                <input class="doneChk" type="checkbox" ${checked} />
                <span class="chkbox"></span>
              </label>

              <input class="repsInput" inputmode="numeric" value="${escapeHtml(s.reps)}" />
              <input class="loadInput" inputmode="decimal" placeholder="lbs" value="${escapeHtml(loadVal)}" />

              <button class="iconbtn bad delSetBtn" type="button" title="Delete set">×</button>
            </div>

            <div class="setTimerBar">
              <div class="setTimerFill"></div>
            </div>

            <div class="setTimerRow">
              <div class="setTimerLeft">
                <span class="setTimerText"></span>
              </div>
              <div class="setTimerActions">
                <button class="setTimerPauseBtn iconbtn ghost" type="button" title="Pause / Resume">⏸</button>
                <button class="setTimerDisableBtn iconbtn ghost" type="button" title="Disable timer">✕</button>
                <button class="setTimerEnableBtn iconbtn ghost hidden" type="button" title="Enable timer">⟲</button>
              </div>
            </div>
          </div>
        `;
      }).join("");

      const enabledChecked = prefs.timer_enabled ? "checked" : "";

      return `
        <div class="excard" data-exid="${escapeHtml(g.exercise_id)}" data-timer-secs="${escapeHtml(clampInt(Number(prefs.timer_secs), 0, 3600))}">
          <div class="excard-top">
            <div class="excard-left">
              <div class="ex-name">${escapeHtml(g.exercise_name)}</div>
              <div class="ex-sub">${escapeHtml(g.exercise_id)}</div>

              <!-- NEW: per-ex timer prefs -->
              <div class="exTimerPrefs">
                <label class="exTimerToggle" title="Enable rest timer for this exercise">
                  <input class="exTimerEnabledChk" type="checkbox" ${enabledChecked} />
                  <span>Timer</span>
                </label>

                <input
                  class="exTimerSecsInput"
                  type="number"
                  min="0"
                  max="3600"
                  step="5"
                  value="${escapeHtml(clampInt(Number(prefs.timer_secs), 0, 3600))}"
                  title="Rest seconds"
                />
                <span class="exTimerUnit">s</span>
              </div>
            </div>

            <div class="excard-actions">
              <button class="iconbtn plus addSetBtn" type="button" title="Add set">+</button>
            </div>
          </div>

          <div class="sets">
            ${setsHtml}
          </div>
        </div>
      `;
    }).join("");

    wireEditorInteractions();
    ensureInlineStylesOnce();

    // After wiring, sync timer UI once.
    updateAllVisibleTimerUIs();
  }

  /* ==============================
     Workout CRUD
  ============================== */
  async function addSetToExercise(exId) {
    if (!activeWorkout) return;

    const ex = await getExerciseById(String(exId));
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
        completed: 0,
        muscles,
      }),
    });

    await loadCurrentWorkoutSets();
    await refreshHistory();

    try {
      const card = workoutEditor?.querySelector(`.excard[data-exid="${CSS.escape(exId)}"]`);
      card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } catch {}
  }

  function wireEditorInteractions() {
    // + set buttons
    workoutEditor.querySelectorAll(".addSetBtn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const card = btn.closest(".excard");
        const exId = String(card?.getAttribute("data-exid") || "");
        if (!exId) return;
        try {
          await addSetToExercise(exId);
        } catch (e) {
          console.error(e);
          alert(e?.message || "Failed to add set.");
        }
      });
    });

    // NEW: per-ex timer prefs controls
    workoutEditor.querySelectorAll(".excard").forEach((card) => {
      const exId = String(card.getAttribute("data-exid") || "");
      if (!exId) return;

      const enabledChk = card.querySelector(".exTimerEnabledChk");
      const secsInput = card.querySelector(".exTimerSecsInput");

      enabledChk?.addEventListener("change", () => {
        if (viewingWorkoutId) return; // keep it simple: prefs edit only in live mode
        const yes = Boolean(enabledChk.checked);

        // update prefs + UI reflect
        setPrefs(exId, { timer_enabled: yes }).catch(() => {});
      });

      secsInput?.addEventListener("change", () => {
        if (viewingWorkoutId) return;
        const secs = clampInt(Number(secsInput.value), 0, 3600);
        secsInput.value = String(secs);
        card.setAttribute("data-timer-secs", String(secs));

        setPrefs(exId, { timer_secs: secs }).catch(() => {});
      });
    });

    // set row controls
    const rows = workoutEditor.querySelectorAll(".setrow");
    rows.forEach((row) => {
      const setId = Number(row.getAttribute("data-setid"));
      if (!setId) return;

      const doneChk = row.querySelector(".doneChk");
      const repsEl = row.querySelector(".repsInput");
      const loadEl = row.querySelector(".loadInput");
      const delBtn = row.querySelector(".delSetBtn");

      const pauseBtn = row.querySelector(".setTimerPauseBtn");
      const disableBtn = row.querySelector(".setTimerDisableBtn");
      const enableBtn = row.querySelector(".setTimerEnableBtn");

      const applyLocalPatch = (patch) => {
        const idx = viewingSets.findIndex((s) => Number(s.id) === setId);
        if (idx < 0) return;

        if (patch.reps !== undefined) viewingSets[idx].reps = patch.reps;
        if (patch.load_lbs !== undefined) viewingSets[idx].load_lbs = patch.load_lbs;
        if (patch.completed !== undefined) viewingSets[idx].completed = patch.completed ? 1 : 0;

        if (patch.reps !== undefined || patch.load_lbs !== undefined) {
          viewingSets[idx].stimulus = computeStimulusSingleSet(viewingSets[idx].reps, viewingSets[idx].load_lbs);
        }
      };

      const pushPendingOrLive = async (patch) => {
        // NEW: emit only completed sets to heat engine
        emitEditorSetsChanged();

        if (viewingWorkoutId) {
          pending.dirty = true;
          const prev = pending.updatesBySetId.get(setId) || {};
          pending.updatesBySetId.set(setId, { ...prev, ...patch });
          updateSaveFooterState();
          return;
        }

        const stim = computeStimulusSingleSet(
          patch.reps !== undefined ? patch.reps : (viewingSets.find(s => s.id === setId)?.reps ?? 1),
          patch.load_lbs !== undefined ? patch.load_lbs : (viewingSets.find(s => s.id === setId)?.load_lbs ?? null)
        );

        const body = { set_id: setId };
        if (patch.reps !== undefined) body.reps = patch.reps;
        if (patch.load_lbs !== undefined) body.load_lbs = patch.load_lbs;
        if (patch.completed !== undefined) body.completed = patch.completed ? 1 : 0;
        body.stimulus = stim;

        await apiJson(API.WORKOUT_UPDATE_SET, {
          method: "POST",
          body: JSON.stringify(body),
        });

        await refreshHistory();
      };

      repsEl?.addEventListener("change", () => {
        (async () => {
          const reps = Math.max(1, parseInt(String(repsEl.value || "1"), 10));
          const loadStr = String(loadEl.value || "").trim();
          const load = loadStr === "" ? null : Math.max(0, Number(loadStr));

          applyLocalPatch({ reps, load_lbs: load });
          renderWorkoutEditor();
          await pushPendingOrLive({ reps, load_lbs: load });
        })().catch(() => {});
      });

      loadEl?.addEventListener("change", () => {
        (async () => {
          const reps = Math.max(1, parseInt(String(repsEl.value || "1"), 10));
          const loadStr = String(loadEl.value || "").trim();
          const load = loadStr === "" ? null : Math.max(0, Number(loadStr));

          applyLocalPatch({ reps, load_lbs: load });
          renderWorkoutEditor();
          await pushPendingOrLive({ reps, load_lbs: load });
        })().catch(() => {});
      });

      doneChk?.addEventListener("change", () => {
        (async () => {
          const completed = doneChk.checked ? 1 : 0;

          // update local immediately
          applyLocalPatch({ completed });

          // Per-set timer behavior (LIVE only)
          if (!viewingWorkoutId) {
            const set = viewingSets.find((s) => Number(s.id) === setId);
            const exId = String(set?.exercise_id || "");
            const prefs = getPrefs(exId);

            const t = ensureSetTimerState(setId);

            if (!prefs.timer_enabled) {
              // if globally disabled for this exercise, treat as disabled
              t.disabled = true;
              stopSetTimer(setId);
            } else {
              // exercise timers enabled
              if (completed === 1) {
                const secs = clampInt(Number(prefs.timer_secs), 0, 3600);
                startSetTimerFor(set, secs);
              } else {
                // uncheck -> stop and reset vibrate flag
                t.disabled = false;
                stopSetTimer(setId);
              }
            }
          }

          renderWorkoutEditor();
          await pushPendingOrLive({ completed });
        })().catch(() => {});
      });

      pauseBtn?.addEventListener("click", () => {
        if (viewingWorkoutId) return;
        togglePauseSetTimer(setId);
        updateSetTimerUIForRow(row, setId);
      });

      disableBtn?.addEventListener("click", () => {
        if (viewingWorkoutId) return;
        disableSetTimer(setId);
        updateSetTimerUIForRow(row, setId);
      });

      enableBtn?.addEventListener("click", () => {
        if (viewingWorkoutId) return;
        enableSetTimer(setId);

        // If the set is already completed, start it immediately with prefs seconds.
        const set = viewingSets.find((s) => Number(s.id) === setId);
        const exId = String(set?.exercise_id || "");
        const prefs = getPrefs(exId);

        if (prefs.timer_enabled && set && Number(set.completed) === 1) {
          const secs = clampInt(Number(prefs.timer_secs), 0, 3600);
          startSetTimerFor(set, secs);
        }

        updateSetTimerUIForRow(row, setId);
      });

      delBtn?.addEventListener("click", async () => {
        if (!confirm("Delete this set?")) return;

        // local remove
        viewingSets = viewingSets.filter((s) => Number(s.id) !== setId);

        // remove timer state too
        setTimers.delete(setId);

        renderWorkoutEditor();

        // NEW: emit only completed sets to heat engine
        emitEditorSetsChanged();

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

    viewingSets = Array.isArray(data.sets) ? data.sets.map(normalizeSetRow) : [];

    // cleanup timer states for sets that no longer exist
    const alive = new Set(viewingSets.map((s) => Number(s.id)));
    for (const sid of setTimers.keys()) {
      if (!alive.has(Number(sid))) setTimers.delete(Number(sid));
    }

    if (activeWorkout?.started_at) {
      const d = parseSqlDateTime(activeWorkout.started_at);
      workoutTimerStartedAtMs = d ? d.getTime() : 0;
    } else {
      workoutTimerStartedAtMs = 0;
    }

    setWorkoutHeaderUI();
    renderWorkoutEditor();

    // NEW: emit only completed sets
    emitEditorSetsChanged();
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

    // NEW: even when viewing past workout, heat should reflect only completed sets
    emitEditorSetsChanged();
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
              <div class="workcard-title">${escapeHtml(fmtWorkoutTitle(w.started_at))}</div>
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
        completed: 0,
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
      const body = { set_id: setId };

      if (patch.reps !== undefined) {
        body.reps = Math.max(1, parseInt(String(patch.reps ?? 1), 10));
      }
      if (patch.load_lbs !== undefined) {
        const load = (patch.load_lbs === null || patch.load_lbs === undefined)
          ? null
          : Math.max(0, Number(patch.load_lbs));
        body.load_lbs = load;
      }
      if (patch.completed !== undefined) {
        body.completed = patch.completed ? 1 : 0;
      }

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
     Timer (workout duration) + per-set timers
  ============================== */
  function tickTimer(now = Date.now()) {
    // tick per-set timers + refresh their UI (live-only)
    if (workoutEditor && !viewingWorkoutId) {
      tickSetTimers(now);
      updateAllVisibleTimerUIs();
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
    await loadPrefsFromServer().catch(() => {});
    await refreshStatus().catch(() => { activeWorkout = null; });

    if (activeWorkout) {
      await loadCurrentWorkoutSets().catch(() => {
        activeWorkout = null;
        viewingWorkoutId = null;
        viewingSets = [];
        clearPending();
        setWorkoutHeaderUI();
        renderWorkoutEditor();
        emitEditorSetsChanged();
      });
    } else {
      viewingWorkoutId = null;
      viewingSets = [];
      clearPending();
      setWorkoutHeaderUI();
      renderWorkoutEditor();
      emitEditorSetsChanged();
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

    // optional prefs setter for future UI
    setPrefs,
  };
}
