// lib/heat_engine.js
function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}
function hours(ms) {
  return ms / (1000 * 60 * 60);
}
function parseSqlDateTime(s) {
  if (!s) return null;
  const iso = String(s).replace(" ", "T");
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Heat engine = builds state.logs (overall/workout) and rebuilds state.muscle from logs.
 * It does NOT paint the model (renderer does that), and it does NOT render DOM.
 *
 * NEW: state.sensitivity (per-group multiplier) lives here so computeHeat() can read it
 * consistently as part of the engine state.
 */
export function createHeatEngine({ apiJson, API, historyPerPage = 5, maxWorkouts = 40, maxAgeMs = 2 * 60 * 1000 }) {
  let heatMode = "overall"; // "overall" | "workout"

  const state = {
    logs: [],
    muscle: {},
    sensitivity: {}, // NEW: { group_id: number } e.g. { chest: 1.15 }
    lastUpdate: Date.now(),
  };

  let workoutSets = []; // current editor sets (active or past workout)

  const overallCache = {
    lastBuiltAt: 0,
    logs: [],
    maxWorkouts,
    maxAgeMs,
  };

  let exerciseWeightsById = {}; // optional fallback if log has no muscles

  function setExerciseWeightsById(map) {
    exerciseWeightsById = map || {};
  }

  function setWorkoutSets(sets) {
    workoutSets = Array.isArray(sets) ? sets : [];

    // CRITICAL: if we're in workout mode, update logs immediately so tick() isn't stale
    if (heatMode === "workout") {
      const now = Date.now();
      state.logs = setsToHeatLogs(workoutSets);
      rebuildMuscleFromLogs(now);
      state.lastUpdate = now;
    }
  }


  function setMode(mode) {
    heatMode = mode === "workout" ? "workout" : "overall";
  }

  function getMode() {
    return heatMode;
  }

  // NEW: sensitivity setters/getters (cleaner than mutating state directly)
  function setSensitivityMap(map) {
    if (!map || typeof map !== "object") {
      state.sensitivity = {};
      return;
    }
    const out = {};
    for (const [k, vRaw] of Object.entries(map)) {
      const gid = String(k || "").trim();
      if (!gid) continue;
      const v = Number(vRaw);
      if (!Number.isFinite(v)) continue;
      out[gid] = v;
    }
    state.sensitivity = out;
  }

  function setSensitivityForGroups(groups, value) {
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    if (!state.sensitivity || typeof state.sensitivity !== "object") state.sensitivity = {};
    for (const g of groups || []) {
      const gid = String(g || "").trim();
      if (!gid) continue;
      state.sensitivity[gid] = v;
    }
  }

  function getSensitivityMap() {
    return state.sensitivity || {};
  }

  function invalidateOverallCache() {
    overallCache.lastBuiltAt = 0;
    overallCache.logs = [];
  }

  function setsToHeatLogs(sets) {
    return (sets || []).map((s) => ({
      id: String(s.id),
      date: "",
      exerciseId: String(s.exercise_id),
      exerciseName: String(s.exercise_name),
      sets: 1,
      reps: Number(s.reps),
      loadLbs: s.load_lbs === null || s.load_lbs === undefined ? null : Number(s.load_lbs),
      stimulus: Number(s.stimulus),
      createdAt: String(s.created_at || ""),
      muscles: (s.muscles && typeof s.muscles === "object") ? s.muscles : null,
    }));
  }

  function rebuildMuscleFromLogs(now = Date.now()) {
    const muscle = {};
    const halfLifeHrs = 36;

    const ensure = (gid) => {
      if (!muscle[gid]) muscle[gid] = { load: 0, lastTrained: 0, lastPing: 0 };
      return muscle[gid];
    };

    for (const l of state.logs) {
      const dt = parseSqlDateTime(l.createdAt);
      if (!dt) continue;
      const tMs = dt.getTime();

      const ageMs = now - tMs;
      const decay = Math.pow(0.5, hours(ageMs) / halfLifeHrs);

      const wmap =
        (l.muscles && typeof l.muscles === "object")
          ? l.muscles
          : (exerciseWeightsById[l.exerciseId] || null);

      if (!wmap) continue;

      const stim = Number(l.stimulus) || 0;
      if (!(stim > 0)) continue;

      for (const [gidRaw, wRaw] of Object.entries(wmap)) {
        const gid = String(gidRaw || "").trim();
        const w = Number(wRaw);
        if (!gid || !Number.isFinite(w) || w <= 0) continue;

        const m = ensure(gid);
        const add = stim * w * decay;
        if (!(add > 0)) continue;

        m.load = clamp01(m.load + add);
        m.lastTrained = Math.max(m.lastTrained, tMs);
      }
    }

    state.muscle = muscle;
    state.lastUpdate = now;
  }

  async function buildOverallLogsCapped() {
    const logs = [];
    let page = 1;
    let fetchedWorkouts = 0;

    while (true) {
      const list = await apiJson(`${API.WORKOUT_LIST}?page=${page}&per=${historyPerPage}`, { method: "GET" });
      const workouts = Array.isArray(list.workouts) ? list.workouts : [];
      if (!workouts.length) break;

      for (const w of workouts) {
        if (fetchedWorkouts >= overallCache.maxWorkouts) break;
        const wid = Number(w.id);
        if (!wid) continue;

        const data = await apiJson(`${API.WORKOUT_GET_ONE}?id=${wid}`, { method: "GET" });
        const sets = Array.isArray(data.sets) ? data.sets : [];

        for (const s of sets) {
          logs.push({
            id: String(s.id),
            date: "",
            exerciseId: String(s.exercise_id),
            exerciseName: String(s.exercise_name),
            sets: 1,
            reps: Number(s.reps),
            loadLbs: s.load_lbs === null || s.load_lbs === undefined ? null : Number(s.load_lbs),
            stimulus: Number(s.stimulus),
            createdAt: String(s.created_at || ""),
            muscles: (s.muscles && typeof s.muscles === "object") ? s.muscles : null,
          });
        }

        fetchedWorkouts++;
      }

      if (fetchedWorkouts >= overallCache.maxWorkouts) break;

      page++;
      if (page > (Number(list.pages) || 1)) break;
    }

    return logs;
  }

  async function rebuildNow() {
    if (heatMode === "workout") {
      state.logs = setsToHeatLogs(workoutSets);
      rebuildMuscleFromLogs(Date.now());
      return state;
    }

    const now = Date.now();
    if (overallCache.logs.length && (now - overallCache.lastBuiltAt) < overallCache.maxAgeMs) {
      state.logs = overallCache.logs;
      rebuildMuscleFromLogs(now);
      return state;
    }

    const logs = await buildOverallLogsCapped();
    overallCache.logs = logs;
    overallCache.lastBuiltAt = now;

    state.logs = logs;
    rebuildMuscleFromLogs(now);
    return state;
  }

  // cheap-ish refresh (uses current state.logs)
  function tick(now = Date.now()) {
    rebuildMuscleFromLogs(now);
    return state;
  }

  function clearAllLocalState() {
    setMode("overall");
    setWorkoutSets([]);
    invalidateOverallCache();
    state.logs = [];
    state.muscle = {};
    state.sensitivity = {}; // NEW
    state.lastUpdate = Date.now();
  }

  return {
    setMode,
    getMode,
    setWorkoutSets,
    setExerciseWeightsById,
    invalidateOverallCache,
    rebuildNow,
    tick,
    getState: () => state,
    clearAllLocalState,

    // NEW exports
    setSensitivityMap,
    setSensitivityForGroups,
    getSensitivityMap,
  };
}
