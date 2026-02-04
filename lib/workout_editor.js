// lib/workout_editor.js
import { escapeHtml, clampInt } from "./utils.js";

export function createWorkoutEditor({
  dom,
  apiJson,
  API,

  getExerciseById,
  computeStimulusSingleSet,

  getPrefs,          // (exId) => prefs
  setPrefs,          // async (exId, patch) => void

  // state accessors
  getActiveWorkout,      // () => activeWorkout|null
  getViewingWorkoutId,   // () => wid|null
  getViewingSets,        // () => sets[]
  setViewingSets,        // (sets[]) => void

  pending,               // {dirty, updatesBySetId, deletes}
  clearPending,          // () => void
  markPendingDirty,      // () => void
  updateSaveFooterState, // () => void

  // callbacks
  onSetsChanged,         // (heatRelevantSets) => void
  onAfterLiveMutation,   // async () => void  (refreshHistory etc)
  timers,                // set timer manager (optional)
}) {
  const { workoutEditor, exerciseSelect } = dom;

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

  function getHeatRelevantSets() {
    const sets = getViewingSets?.() || [];
    return sets.filter((s) => Number(s.completed) === 1);
  }

  function emitSetsChanged() {
    onSetsChanged?.(getHeatRelevantSets());
  }

  function groupSetsByExercise(sets) {
    const map = new Map();
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

  function findLocalLastCompletedSetForExercise(exId) {
    const sets = getViewingSets?.() || [];
    const filtered = sets.filter((s) => String(s.exercise_id) === String(exId) && Number(s.completed) === 1);
    if (!filtered.length) return null;
    // choose “latest” by id (monotonic)
    filtered.sort((a, b) => Number(a.id) - Number(b.id));
    return filtered[filtered.length - 1] || null;
  }

  async function fetchGlobalLastCompletedSetForExercise(exId) {
    try {
      const data = await apiJson(
        `${API.LAST_SETS_FOR_EX}?exercise_id=${encodeURIComponent(String(exId))}&last_completed_only=1`,
        { method: "GET" }
      );
      const s = data?.last_completed_set || null;
      if (!s || typeof s !== "object") return null;
      return {
        reps: Math.max(1, parseInt(String(s.reps ?? 10), 10) || 10),
        load_lbs: (s.load_lbs === null || s.load_lbs === undefined || s.load_lbs === "")
          ? null
          : Math.max(0, Number(s.load_lbs)),
      };
    } catch (e) {
      console.warn("[memory] last_completed_only fetch failed:", e);
      return null;
    }
  }

  // tiny inline helpers only
  let __stylesInjected = false;
  function ensureInlineStylesOnce() {
    if (__stylesInjected) return;
    __stylesInjected = true;

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

  function render() {
    if (!workoutEditor) return;

    const viewingWorkoutId = getViewingWorkoutId?.();
    const activeWorkout = getActiveWorkout?.();
    const viewingSets = getViewingSets?.() || [];

    if (!viewingSets.length) {
      if (viewingWorkoutId) workoutEditor.innerHTML = `<div class="muted">No sets in this workout.</div>`;
      else if (!activeWorkout) workoutEditor.innerHTML = `<div class="muted">Start a workout to add exercises.</div>`;
      else workoutEditor.innerHTML = `<div class="muted">Add an exercise to begin.</div>`;
      return;
    }

    const groups = groupSetsByExercise(viewingSets);

    workoutEditor.innerHTML = groups.map((g) => {
      const prefs = getPrefs(g.exercise_id);

      const setsHtml = g.sets.map((s) => {
        const loadVal = (s.load_lbs === null || s.load_lbs === undefined) ? "" : String(s.load_lbs);
        const checked = s.completed ? "checked" : "";

        // ensure timer state exists so UI can reflect disabled/paused etc
        timers?.ensureState?.(Number(s.id));

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
              <button class="iconbtn bad removeExBtn" type="button" title="Remove exercise">🗑</button>
              <button class="iconbtn plus addSetBtn" type="button" title="Add set">+</button>
            </div>
          </div>

          <div class="sets">
            ${setsHtml}
          </div>
        </div>
      `;
    }).join("");

    wireInteractions();
    ensureInlineStylesOnce();

    timers?.updateAllVisibleUIs?.();
  }

  async function addSetToExercise(exId) {
    const activeWorkout = getActiveWorkout?.();
    if (!activeWorkout) return;

    const ex = await getExerciseById(String(exId));
    if (!ex) return;

    // NEW: default from most recent CHECKED-OFF set (prefer local current workout history, then global DB history)
    let reps = 10;
    let load = null;

    const localLast = findLocalLastCompletedSetForExercise(exId);
    if (localLast) {
      reps = Math.max(1, parseInt(String(localLast.reps ?? 10), 10) || 10);
      load = (localLast.load_lbs === null || localLast.load_lbs === undefined) ? null : Math.max(0, Number(localLast.load_lbs));
    } else {
      const globalLast = await fetchGlobalLastCompletedSetForExercise(exId);
      if (globalLast) {
        reps = Math.max(1, parseInt(String(globalLast.reps ?? 10), 10) || 10);
        load = (globalLast.load_lbs === null || globalLast.load_lbs === undefined) ? null : Math.max(0, Number(globalLast.load_lbs));
      }
    }

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
  }

  function wireInteractions() {
    // + set buttons
    workoutEditor.querySelectorAll(".addSetBtn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const card = btn.closest(".excard");
        const exId = String(card?.getAttribute("data-exid") || "");
        if (!exId) return;

        try {
          await addSetToExercise(exId);
          await onAfterLiveMutation?.(); // loadCurrentWorkoutSets + refreshHistory
        } catch (e) {
          console.error(e);
          alert(e?.message || "Failed to add set.");
        }
      });
    });

    // NEW: remove exercise (all sets for exercise in current view)
    workoutEditor.querySelectorAll(".removeExBtn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const card = btn.closest(".excard");
        const exId = String(card?.getAttribute("data-exid") || "");
        if (!exId) return;

        if (!confirm("Remove this exercise (delete all its sets)?")) return;

        // collect set ids in that card
        const setIds = [...(card?.querySelectorAll?.(".setrow") || [])]
          .map((r) => Number(r.getAttribute("data-setid")))
          .filter((n) => Number.isFinite(n) && n > 0);

        // local remove first for immediate UI response
        const remaining = (getViewingSets?.() || []).filter((s) => String(s.exercise_id) !== exId);
        setViewingSets?.(remaining);

        // remove timer state too
        for (const sid of setIds) timers?._map?.delete?.(sid);

        render();

        // emit only completed sets
        emitSetsChanged();

        // past edit: queue deletes only
        if (getViewingWorkoutId?.()) {
          markPendingDirty?.();
          for (const sid of setIds) {
            pending.deletes.add(sid);
            pending.updatesBySetId.delete(sid);
          }
          updateSaveFooterState?.();
          return;
        }

        // live: delete on server by exercise_id
        try {
          await apiJson("/musclemap/api/workout/delete_sets_for_exercise.php", {
            method: "POST",
            body: JSON.stringify({ exercise_id: exId }),
          });
        } catch (e) {
          console.error(e);
          alert(e?.message || "Failed to remove exercise.");
        }

        await onAfterLiveMutation?.();
      });
    });

    // per-ex timer prefs
    workoutEditor.querySelectorAll(".excard").forEach((card) => {
      const exId = String(card.getAttribute("data-exid") || "");
      if (!exId) return;

      const enabledChk = card.querySelector(".exTimerEnabledChk");
      const secsInput = card.querySelector(".exTimerSecsInput");

      enabledChk?.addEventListener("change", () => {
        if (getViewingWorkoutId?.()) return; // prefs edit only live
        const yes = Boolean(enabledChk.checked);
        setPrefs?.(exId, { timer_enabled: yes }).catch(() => {});
      });

      secsInput?.addEventListener("change", () => {
        if (getViewingWorkoutId?.()) return;
        const secs = clampInt(Number(secsInput.value), 0, 3600);
        secsInput.value = String(secs);
        card.setAttribute("data-timer-secs", String(secs));
        setPrefs?.(exId, { timer_secs: secs }).catch(() => {});
      });
    });

    // set row controls
    workoutEditor.querySelectorAll(".setrow").forEach((row) => {
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
        const sets = getViewingSets?.() || [];
        const idx = sets.findIndex((s) => Number(s.id) === setId);
        if (idx < 0) return;

        if (patch.reps !== undefined) sets[idx].reps = patch.reps;
        if (patch.load_lbs !== undefined) sets[idx].load_lbs = patch.load_lbs;
        if (patch.completed !== undefined) sets[idx].completed = patch.completed ? 1 : 0;

        if (patch.reps !== undefined || patch.load_lbs !== undefined) {
          sets[idx].stimulus = computeStimulusSingleSet(sets[idx].reps, sets[idx].load_lbs);
        }

        setViewingSets?.(sets);
      };

      const pushPendingOrLive = async (patch) => {
        // emit only completed sets to heat engine
        emitSetsChanged();

        if (getViewingWorkoutId?.()) {
          markPendingDirty?.();
          const prev = pending.updatesBySetId.get(setId) || {};
          pending.updatesBySetId.set(setId, { ...prev, ...patch });
          updateSaveFooterState?.();
          return;
        }

        const sets = getViewingSets?.() || [];
        const current = sets.find((s) => Number(s.id) === setId);

        const stim = computeStimulusSingleSet(
          patch.reps !== undefined ? patch.reps : (current?.reps ?? 1),
          patch.load_lbs !== undefined ? patch.load_lbs : (current?.load_lbs ?? null)
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

        await onAfterLiveMutation?.(); // refreshHistory at minimum
      };

      repsEl?.addEventListener("change", () => {
        (async () => {
          const reps = Math.max(1, parseInt(String(repsEl.value || "1"), 10));
          const loadStr = String(loadEl.value || "").trim();
          const load = loadStr === "" ? null : Math.max(0, Number(loadStr));

          applyLocalPatch({ reps, load_lbs: load });
          render();
          await pushPendingOrLive({ reps, load_lbs: load });
        })().catch(() => {});
      });

      loadEl?.addEventListener("change", () => {
        (async () => {
          const reps = Math.max(1, parseInt(String(repsEl.value || "1"), 10));
          const loadStr = String(loadEl.value || "").trim();
          const load = loadStr === "" ? null : Math.max(0, Number(loadStr));

          applyLocalPatch({ reps, load_lbs: load });
          render();
          await pushPendingOrLive({ reps, load_lbs: load });
        })().catch(() => {});
      });

      doneChk?.addEventListener("change", () => {
        (async () => {
          const completed = doneChk.checked ? 1 : 0;

          applyLocalPatch({ completed });

          // LIVE-only per-set timer behavior
          if (!getViewingWorkoutId?.()) {
            const sets = getViewingSets?.() || [];
            const setRow = sets.find((s) => Number(s.id) === setId);
            timers?.handleCompletedToggleLive?.(setRow, completed);
          }

          render();
          await pushPendingOrLive({ completed });
        })().catch(() => {});
      });

      pauseBtn?.addEventListener("click", () => {
        if (getViewingWorkoutId?.()) return;
        timers?.togglePause?.(setId);
        timers?.updateRowUI?.(row, setId);
      });

      disableBtn?.addEventListener("click", () => {
        if (getViewingWorkoutId?.()) return;
        timers?.disable?.(setId);
        timers?.updateRowUI?.(row, setId);
      });

      enableBtn?.addEventListener("click", () => {
        if (getViewingWorkoutId?.()) return;
        timers?.enable?.(setId);

        const sets = getViewingSets?.() || [];
        const setRow = sets.find((s) => Number(s.id) === setId);
        const exId = String(setRow?.exercise_id || "");
        const prefs = getPrefs?.(exId) || { timer_enabled: true, timer_secs: 60 };

        if (prefs.timer_enabled && setRow && Number(setRow.completed) === 1) {
          timers?.startForSetRow?.(setRow, clampInt(Number(prefs.timer_secs), 0, 3600));
        }

        timers?.updateRowUI?.(row, setId);
      });

      delBtn?.addEventListener("click", async () => {
        if (!confirm("Delete this set?")) return;

        // local remove
        const sets = (getViewingSets?.() || []).filter((s) => Number(s.id) !== setId);
        setViewingSets?.(sets);

        // remove timer state too
        timers?._map?.delete?.(setId);

        render();

        // emit only completed sets
        emitSetsChanged();

        if (getViewingWorkoutId?.()) {
          markPendingDirty?.();
          pending.deletes.add(setId);
          pending.updatesBySetId.delete(setId);
          updateSaveFooterState?.();
          return;
        }

        await apiJson(API.WORKOUT_DELETE_SET, {
          method: "POST",
          body: JSON.stringify({ set_id: setId }),
        });

        await onAfterLiveMutation?.();
      });
    });
  }

  return {
    normalizeSetRow,
    render,
    emitSetsChanged,
  };
}
