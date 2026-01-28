// lib/api.js
export const API = {
  WORKOUT_STATUS:      "./api/workout/status.php",
  WORKOUT_START:       "./api/workout/start.php",
  WORKOUT_END:         "./api/workout/end.php",
  WORKOUT_GET_CURRENT: "./api/workout/get_current.php",
  WORKOUT_ADD_SET:     "./api/workout/add_set.php",
  WORKOUT_UPDATE_SET:  "./api/workout/update_set.php",
  WORKOUT_DELETE_SET:  "./api/workout/delete_set.php",
  WORKOUT_GET_ONE:     "./api/workout/get_workout.php",
  WORKOUT_LIST:        "./api/workout/list_workouts.php",

  // legacy reset (shared DB wipe)
  STATE_RESET:         "./api/state_reset.php",

  // NEW: per-muscle sensitivity
  SENSITIVITY_GET:    "./api/muscle_sensitivity.php",
  SENSITIVITY_SET:     "./api/muscle_sensitivity.php",
};

export async function apiJson(url, opts = {}) {
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

export async function resetStateServer() {
  try {
    const res = await fetch(API.STATE_RESET, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
    });
    const text = await res.text();
    const json = JSON.parse(text);
    return json && json.ok === true;
  } catch (e) {
    console.warn("[reset] failed:", e);
    return false;
  }
}
