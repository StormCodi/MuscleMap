# MuscleMap Developer Manual

## Overview
MuscleMap is a web application for tracking workouts and visualizing muscle recovery using a 3D body model. It features a PHP backend with MySQL database for data persistence, and a JavaScript frontend using Three.js for rendering. The app allows logging workouts, viewing muscle states, and generating recovery recommendations. All users share a global user ID (0) for simplicity.

## High-Level Architecture Diagram
```
+-------------+     +----------------+     +-----------------+
|  Browser    |     |  PHP API       |     |  MySQL DB       |
|  (index.html|     |  (api/*.php)   |     |  (musclemap)    |
|   main.js   |<--->|  db.php        |<--->|  Tables:        |
|   lib/*.js  |     |  Endpoints     |     |  - exercises    |
|   style.css |     |                |     |  - exercises_custom|
+-------------+     +----------------+     |  - workout_logs |
                           |                |  - muscle_state |
                           v                +-----------------+
                     +----------------+
                     | 3D Rendering   |
                     | (Three.js)     |
                     +----------------+
```

## 1) Directory/Module Map
- **api/**: Backend PHP files.
  - `add_exercises.php`: Handles adding or updating custom exercises via POST. Validates input and upserts into `exercises_custom`.
  - `db.php`: Database connection setup. Defines PDO connection to MySQL database `musclemap` with global user ID `GLOBAL_USER_ID = 0`.
  - `exercises_list.php`: GET endpoint to list active exercises from `exercises` table.
  - `get_exercises.php`: GET endpoint to list custom exercises from `exercises_custom` table.
  - `get_logs.php`: GET endpoint to fetch recent workout logs from `workout_logs` table (up to 250 rows).
  - `get_muscle_state.php`: GET endpoint to fetch muscle states from `muscle_state` table.
  - `log_workout.php`: POST endpoint to log a workout. Inserts into `workout_logs` and updates `muscle_state`.
  - `state_reset.php`: POST endpoint to delete data from `workout_logs` and `muscle_state` for the global user.
- **lib/**: JavaScript modules.
  - `exercises.js`: Fetches and caches exercise lists from `api/exercises_list.php`. Exports `getAllExercisesCached()`, `getExerciseById(id)`, `bustExercisesCache()`.
  - `muscleMap.js`: Defines muscle groups and classification for 3D meshes. Exports `GROUPS` array and `classifyMeshName(name)` function.
  - `recovery.js`: Handles muscle recovery logic. Exports `ensureMuscle(state, id)`, `tickDecay(state, now)`, `applyStimulus(state, id, stimulus, now)`, `computeHeat(state, id, now)`, `isNeglected(state, id, now)`.
  - `recs.js`: Generates workout recommendations. Exports `generateRecs(state, groupIds, now)`.
  - `storage.js`: LocalStorage management (not used in provided code; appears vestigial). Exports `loadState()`, `saveState(state)`, `resetState()`, but main.js uses server APIs instead.
- **assets/models/**: Referenced for GLB models (e.g., `body.glb`, `body.draco.glb`), but files not provided.
- `index.html`: Main page with UI elements (viewer, sidebar, forms).
- `main.js`: Core frontend logic. Sets up Three.js, handles API calls (e.g., `apiJson(url, opts)`), loads models, manages state, UI rendering, and event listeners (e.g., `onLogWorkout(ev)`, `renderExerciseOptions()`).
- `style.css`: CSS styles for the UI.
- `vendor/three/**`: Three.js library (imported via importmap in index.html).

## 2) Data Model (tables + key fields)
Tables and fields inferred from SQL queries in provided files. Only including what appears.

- **exercises**: Stores predefined exercises.
  - `user_id`: Integer, user identifier (uses `GLOBAL_USER_ID = 0`).
  - `exercise_key`: String, unique ID (e.g., "bench_press").
  - `name`: String, exercise name.
  - `weights_json`: JSON string, muscle group weights (e.g., {"chest": 1.0}).
  - `is_active`: Integer (1 for active).
- **exercises_custom**: Stores user-custom exercises.
  - `user_id`: Integer, user identifier (uses `GLOBAL_USER_ID = 0`).
  - `exercise_key`: String, unique ID.
  - `name`: String, exercise name.
  - `weights_json`: JSON string, muscle group weights.
  - `updated_at`: Timestamp, last update time.
- **workout_logs**: Stores workout entries.
  - `id`: Integer, auto-increment primary key.
  - `user_id`: Integer, user identifier (uses `GLOBAL_USER_ID = 0`).
  - `workout_date`: String (e.g., "YYYY-MM-DD").
  - `exercise_id`: String, references exercise_key.
  - `exercise_name`: String, exercise name.
  - `sets`: Integer, number of sets.
  - `reps`: Integer, reps per set.
  - `load_lbs`: Float (nullable), weight in lbs.
  - `stimulus`: Float, computed stimulus value.
  - `created_at`: Timestamp, insertion time.
- **muscle_state**: Tracks per-muscle recovery state.
  - `user_id`: Integer, user identifier (uses `GLOBAL_USER_ID = 0`).
  - `muscle_group`: String, group ID (e.g., "chest").
  - `load_value`: Float, recovery load (0-1).
  - `last_trained_at`: Integer (Unix timestamp), last trained time.
  - `last_ping_at`: Integer (Unix timestamp), last ping time.

No other tables found in provided files.

## 3) API Endpoints
All endpoints return JSON. Errors use HTTP codes (e.g., 400, 500) with `{"ok": false, "error": "msg"}`.

- **/api/add_exercises.php** (POST): Add/update custom exercise.
  - Request JSON: `{"id": "string", "name": "string", "w": {"group": float, ...}}` (w: muscle weights 0-1).
  - Response JSON: `{"ok": true}` on success.
  - Errors: 400 ("invalid_json", "bad_id", "bad_name", "bad_weights", "empty_weights"); 500 ("server_error").
- **/api/exercises_list.php** (GET): List active exercises.
  - Request: None.
  - Response JSON: `{"ok": true, "exercises": [{"id": "string", "name": "string", "w": {"group": float, ...}}, ...]}`.
  - Errors: 500 ("server_error").
- **/api/get_exercises.php** (GET): List custom exercises.
  - Request: None.
  - Response JSON: `{"ok": true, "exercises": [{"id": "string", "name": "string", "w": {"group": float, ...}}, ...]}`.
  - Errors: 500 ("server_error").
- **/api/get_logs.php** (GET): Get recent workout logs (LIMIT 250).
  - Request: None.
  - Response JSON: `{"ok": true, "rows": [{"id": int, "workout_date": "string", "exercise_id": "string", "exercise_name": "string", "sets": int, "reps": int, "load_lbs": float|null, "stimulus": float}, ...]}`.
  - Errors: None explicit; throws on DB error.
- **/api/get_muscle_state.php** (GET): Get muscle states.
  - Request: None.
  - Response JSON: `{"ok": true, "rows": [{"muscle_group": "string", "load_value": float, "last_trained_at": int, "last_ping_at": int}, ...]}`.
  - Errors: None explicit; throws on DB error.
- **/api/log_workout.php** (POST): Log a workout and update muscle states.
  - Request JSON: `{"date": "YYYY-MM-DD", "exercise_id": "string", "exercise_name": "string", "sets": int, "reps": int, "load_lbs": float|null, "stimulus": float, "muscles": {"group": float, ...}}`.
  - Response JSON: `{"ok": true}` on success.
  - Errors: 400 ("Invalid JSON", "Missing [field]", "muscles must be an object map"); 500 (exception/PHP error/fatal messages).
- **/api/state_reset.php** (POST): Reset data for global user.
  - Request: None (empty body).
  - Response JSON: `{"ok": true, "deleted_logs": int, "deleted_muscles": int}`.
  - Errors: 500 (exception/PHP error/fatal messages).

## 4) Frontend Flow (pages, JS modules, how calls happen)
Single page: `index.html` with sidebar for logging, logs, recs, and 3D viewer.

- **Pages**: Only `index.html` (loads `main.js` via script type="module").
- **JS Modules**: Imported in `main.js` (e.g., `import { getAllExercisesCached } from "./lib/exercises.js"`). Uses Three.js for 3D (via importmap).
- **Request/Response Flow**:
  - UI (index.html) -> JS (main.js: event listeners like `logForm.addEventListener("submit", onLogWorkout)`) -> PHP API (e.g., `apiJson(API_WORKOUT_LOG, {method: "POST", body: JSON.stringify(...)})`) -> DB (PDO queries in api/*.php) -> No AI provider found in files -> DB (updates) -> Response to JS (e.g., reload state via `loadMuscleStateServer()`, `loadLogsServer()`) -> UI (render functions like `renderLogs()`, `applyHeatToAllMeshes()`).
  - Boot: `boot()` in main.js loads state/logs from server, renders UI, loads GLB model.
  - Loop: `animate()` updates rendering and decays state every 2s via `tickDecay(state, now)`.
  - No sessions/messages/images found; exercises/logs/muscle_state are core.

## 5) AI Intake / MMJ schema explanation (if present)
Not found in provided files.

## 6) How to Extend
- **Adding an Exercise**: Send POST to `api/add_exercises.php` with JSON (e.g., {"id": "new_id", "name": "New Exercise", "w": {"chest": 0.8}}). In JS, call `bustExercisesCache()` and re-render options via `renderExerciseOptions()` in main.js. Predefined exercises require DB insert into `exercises` table (not handled in code).
- **Adding a Muscle Group**: Add to `GROUPS` array in `lib/muscleMap.js` (e.g., {id: "new_group", label: "New Group", tokens: ["token"], kind: "region"}). Update `classifyMeshName(name)` if needed. Ensure 3D model meshes match tokens. In API, no change needed as groups are dynamic in `muscle_state` and `weights_json`.
- **Adding a New Endpoint**: Create new PHP file in api/ (e.g., new_endpoint.php). Include
