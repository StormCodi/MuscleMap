// lib/set_timers.js
import { clampInt, fmtMMSS } from "./utils.js";

/**
 * Per-set timer manager (LIVE-ONLY).
 * - Keeps timer runtime state (client-only).
 * - Knows how to update timer UI inside set rows.
 * - Does NOT own workout/sets state; caller passes viewingSets as needed.
 */
export function createSetTimerManager({
  workoutEditor,
  getPrefs,                 // (exId) => {timer_enabled, timer_secs}
  isEditingPast,            // () => boolean
  getViewingSets,           // () => array of normalized sets
  findNextIncompleteRowInExercise, // (exId) => HTMLElement|null
  highlightRow,             // (el) => void
}) {
  // setId -> state
  const setTimers = new Map();

  function safeVibrate(ms = 200) {
    try {
      if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(ms);
    } catch {}
  }

  function getState(setId) {
    const t = setTimers.get(setId);
    return (t && typeof t === "object") ? t : null;
  }

  function ensureState(setId) {
    const existing = getState(setId);
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

  function stop(setId) {
    const t = getState(setId);
    if (!t) return;
    t.running = false;
    t.paused = false;
    t.totalSec = 0;
    t.endAtMs = 0;
    t.remainingSec = 0;
    t.pausedRemainingSec = 0;
    t.doneVibrated = false;
  }

  function disable(setId) {
    const t = ensureState(setId);
    t.disabled = true;
    stop(setId);
  }

  function enable(setId) {
    const t = ensureState(setId);
    t.disabled = false;
    // do not auto-start here; caller may start depending on completed status
  }

  function startForSetRow(setRow, seconds) {
    if (!setRow) return;
    const setId = Number(setRow.id);
    if (!setId) return;

    const t = ensureState(setId);
    if (t.disabled) return;

    const secs = clampInt(Number(seconds), 0, 3600);
    if (secs <= 0) {
      stop(setId);
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

  function togglePause(setId) {
    const t = getState(setId);
    if (!t || t.disabled) return;
    if (!t.running && !t.paused) return;

    if (t.running) {
      const now = Date.now();
      t.remainingSec = Math.max(0, Math.ceil((t.endAtMs - now) / 1000));
      t.pausedRemainingSec = t.remainingSec;
      t.running = false;
      t.paused = true;
    } else if (t.paused) {
      const now = Date.now();
      const rem = clampInt(Number(t.pausedRemainingSec), 0, 3600);
      if (rem <= 0) {
        t.paused = false;
        stop(setId);
        return;
      }
      t.running = true;
      t.paused = false;
      t.remainingSec = rem;
      t.endAtMs = now + rem * 1000;
    }
  }

  function cleanupNotAlive(aliveSetIds) {
    const alive = new Set((aliveSetIds || []).map((x) => Number(x)));
    for (const sid of setTimers.keys()) {
      if (!alive.has(Number(sid))) setTimers.delete(Number(sid));
    }
  }

  function updateRowUI(rowEl, setId) {
    if (!rowEl) return;

    const t = getState(setId);
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

    bar?.classList.toggle("disabled", disabled);
    bar?.classList.toggle("paused", paused);

    if (enableBtn) enableBtn.classList.toggle("hidden", !disabled);
    if (pauseBtn) pauseBtn.classList.toggle("hidden", disabled);
    if (disableBtn) disableBtn.classList.toggle("hidden", disabled);

    let pct = 100;
    let label = "";

    if (disabled) {
      pct = 100;
      label = "Off";
    } else if (!completed) {
      pct = 100;
      label = "";
    } else {
      if (total > 0) pct = Math.max(0, Math.min(100, (remaining / total) * 100));
      else pct = running || paused ? 100 : 0;

      if (running || paused) label = fmtMMSS(remaining);
      else if (total > 0 && remaining <= 0) label = "Done";
      else label = "";
    }

    if (fill) fill.style.width = `${pct}%`;
    if (txt) txt.textContent = label;

    if (pauseBtn) {
      pauseBtn.textContent = paused ? "▶" : "⏸";
      pauseBtn.disabled = !(completed && (running || paused));
    }
  }

  function updateAllVisibleUIs() {
    if (!workoutEditor) return;
    workoutEditor.querySelectorAll(".setrow").forEach((rowEl) => {
      const setId = Number(rowEl.getAttribute("data-setid") || "0");
      if (!setId) return;
      updateRowUI(rowEl, setId);
    });
  }

  function tick(now = Date.now()) {
    if (isEditingPast?.()) return;

    for (const [setId, t] of setTimers.entries()) {
      if (!t || t.disabled) continue;
      if (!t.running) continue;

      const remaining = Math.ceil((t.endAtMs - now) / 1000);
      t.remainingSec = Math.max(0, remaining);

      if (t.remainingSec <= 0) {
        t.running = false;
        t.paused = false;

        if (!t.doneVibrated) {
          t.doneVibrated = true;
          safeVibrate(200);
        }

        const set = (getViewingSets?.() || []).find((s) => Number(s.id) === Number(setId));
        const exId = String(set?.exercise_id || "");
        if (exId) {
          const nextRow = findNextIncompleteRowInExercise?.(exId);
          if (nextRow) highlightRow?.(nextRow);
        }
      }
    }
  }

  /**
   * Called when a set checkbox changed (LIVE ONLY). Mirrors your previous behavior.
   */
  function handleCompletedToggleLive(setRow, completed) {
    if (isEditingPast?.()) return;
    if (!setRow) return;

    const setId = Number(setRow.id);
    if (!setId) return;

    const exId = String(setRow.exercise_id || "");
    const prefs = getPrefs?.(exId) || { timer_enabled: true, timer_secs: 60 };
    const t = ensureState(setId);

    if (!prefs.timer_enabled) {
      t.disabled = true;
      stop(setId);
      return;
    }

    if (completed === 1) {
      t.disabled = false;
      startForSetRow(setRow, clampInt(Number(prefs.timer_secs), 0, 3600));
    } else {
      t.disabled = false;
      stop(setId);
    }
  }

  return {
    // state
    ensureState,
    getState,
    cleanupNotAlive,

    // actions
    stop,
    disable,
    enable,
    startForSetRow,
    togglePause,
    handleCompletedToggleLive,

    // ui + ticking
    updateRowUI,
    updateAllVisibleUIs,
    tick,

    // expose for debugging if needed
    _map: setTimers,
  };
}
