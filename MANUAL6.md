# MuscleMap Developer Manual

This manual documents the MuscleMap project, a web application for tracking workouts, visualizing muscle recovery using a 3D model, and generating recommendations. It uses PHP for backend APIs, MySQL for data storage, JavaScript (with Three.js) for the frontend, and a shared global user (ID 0) for simplicity. There are no user sessions, authentication, messages, images, or AI provider integrations in the provided code—any such features are "not found in provided files." The application is single-user/shared (GLOBAL_USER_ID=0), with data stored in a MySQL database named "musclemap." Frontend rendering uses Three.js for 3D muscle visualization, with local predictions for UI responsiveness and server-side persistence.

## High-Level Architecture Diagram

```
+----------------+     +----------------+     +----------------+
|   UI (HTML/JS) |<--->| JS Modules     |<--->| PHP API        |
| - index.html   |     | - main.js      |     | - api/*.php    |
| - style.css    |     | - lib/*.js     |     |                |
+----------------+     +----------------+     +----------------+
                                       |
                                       v
                               +----------------+
                               | MySQL DB       |
                               | - musclemap    |
                               +----------------+
```

- **UI Layer**: Renders 3D model and handles user interactions via Three.js and DOM events.
- **JS Layer**: Manages state, API calls, local simulations (e.g., recovery decay), and recommendations.
- **API Layer**: PHP endpoints handle CRUD operations on the DB using PDO.
- **DB Layer**: MySQL stores exercises, logs, and muscle states. No AI provider integration (not found in provided files).

## 1) Directory/Module Map

### PHP Files (API Endpoints)
All PHP files are in the `api/` directory and use `db.php` for PDO-based MySQL connections. They handle JSON requests/responses and use a global user ID (0). Error handling includes HTTP codes and JSON errors like `{"ok": false, "error": "msg"}`.

- **api/db.php**: Establishes a PDO connection to the MySQL database (`musclemap`). Defines constants like `GLOBAL_USER_ID` (hardcoded to 0 for shared access). No functions; it's required by other APIs for `$pdo`.
- **api/add_exercises.php**: Handles POST requests to add or update custom exercises in the `exercises_custom` table.
- **api/exercises_list.php**: Handles GET requests to list active exercises from the `exercises` table.
- **api/get_exercises.php**: Handles GET requests to fetch exercises from the `exercises_custom` table.
- **api/get_logs.php**: Handles GET requests to fetch recent workout logs from `workout_logs`.
- **api/get_muscle_state.php**: Handles GET requests to fetch muscle states from `muscle_state`.
- **api/log_workout.php**: Handles POST requests to log a workout, inserting into `workout_logs` and updating `muscle_state`.
- **api/state_reset.php**: Handles POST requests to reset data in `workout_logs` and `muscle_state`.

### JavaScript Modules
All JS files are in `lib/` except `main.js` (root). They handle UI logic, 3D rendering, and API interactions. `main.js` is the entry point, using ES modules and Three.js.

- **lib/exercises.js**: Caches and fetches exercises from `api/exercises_list.php`. Exports `getAllExercisesCached()` (with 60s TTL), `getExerciseById(id)`, and `bustExercisesCache()`. Uses `fetch` with no-store cache.
- **lib/muscleMap.js**: Defines muscle groups (`GROUPS` array with `id`, `label`, `tokens` for mesh matching). Exports `GROUPS` and `classifyMeshName(name)` to categorize 3D meshes as "shell" (skin), "gym" (clickable muscles), or "ignore" based on name tokens. Rejects micro-muscles (e.g., face/hands).
- **lib/recovery.js**: Local logic for muscle recovery simulation. Exports functions like `ensureMuscle(state, id)`, `tickDecay(state, now)` (decays `load` with 36-hour half-life), `applyStimulus(state, id, stimulus, now)` (adds to `load`, caps at 1), `computeHeat(state, id, now)` (calculates heat 0-1 and overdo flag), and `isNeglected(state, id, now)` (true if >8 days since last trained).
- **lib/recs.js**: Generates workout recommendations. Exports `generateRecs(state, groupIds, now)` which computes heat/overdo/neglect for each group and returns prioritized items (e.g., warn for overdo, nudge for neglected).
- **lib/storage.js**: Handles localStorage for state (key "musclemap.v1"). Exports `loadState()`, `saveState(state)`, `resetState()`. Normalizes state with `logs[]`, `muscle{}`, `lastUpdate`. **Note:** Unused in `main.js`; state is loaded from server APIs instead.
- **main.js**: Core script. Sets up Three.js scene, camera, controls, lights, and grid. Loads GLB model (`body.glb` or Draco fallback) from `./assets/models/`. Classifies meshes, handles picking/selection, applies heat visuals. Wires UI (forms, buttons) to APIs like `log_workout.php`. Loads state from server (`loadMuscleStateServer()`, `loadLogsServer()`), predicts locally, then syncs. Animates with decay every 2s. Handles reset via `state_reset.php`.

### HTML/CSS
- **index.html**: Main page with Three.js canvas (`#view`), HUD, sidebar panels (workout log form, selected muscle, legend, recommendations, recent logs). Imports Three.js via importmap. Loads `main.js`.
- **style.css**: Responsive CSS (mobile-first, desktop grid). Defines variables for colors, layouts panels/forms/buttons.

## 2) Data Model (Tables + Key Fields)

Based on SQL queries in PHP files. No schema definitions provided; inferred from usage. All tables use `user_id` (int, GLOBAL_USER_ID=0). No foreign keys or indexes mentioned. Sessions, messages, and images are not found in provided files.

### Tables
- **exercises_custom**: Stores user-defined exercises.
  - `user_id`: int (e.g., 0) – Shared global user identifier.
  - `exercise_key`: string (snake_case, 2-64 chars, primary/unique with user_id) – Unique key for the exercise.
  - `name`: string (up to 128 chars) – Display name of the exercise.
  - `weights_json`: JSON object of muscle_group:weight (0-1 floats) – Muscle weights for stimulus distribution.
  - `updated_at`: timestamp (auto-updated on UPSERT) – Last update time.

- **exercises**: Similar to `exercises_custom`, but with `is_active` filter in queries.
  - `user_id`: int (e.g., 0) – Shared global user identifier.
  - `exercise_key` (as id): string – Unique key for the exercise.
  - `name`: string – Display name of the exercise.
  - `weights_json`: JSON object of muscle_group:weight (0-1 floats) – Muscle weights for stimulus distribution.
  - `is_active`: int (1=active) – Flag for active exercises.

- **workout_logs**: Stores workout entries.
  - `id`: int (auto-increment?) – Unique log entry ID.
  - `user_id`: int – Shared global user identifier.
  - `workout_date`: string (e.g., "YYYY-MM-DD") – Date of the workout.
  - `exercise_id`: string – ID of the exercise performed.
  - `exercise_name`: string – Name of the exercise.
  - `sets`: int – Number of sets.
  - `reps`: int – Number of reps per set.
  - `load_lbs`: float (nullable) – Weight used in lbs.
  - `stimulus`: float (computed volume) – Calculated stimulus value.
  - `created_at`: timestamp – Creation time.

- **muscle_state**: Tracks per-muscle recovery.
  - `user_id`: int – Shared global user identifier.
  - `muscle_group`: string (e.g., "chest", primary/unique with user_id) – Muscle group identifier.
  - `load_value`: float (0-1, incremented by stimulus*weight, capped at 1) – Current load/recovery value.
  - `last_trained_at`: int (Unix timestamp seconds) – Last time the muscle was trained.
  - `last_ping_at`: int – Last ping time (purpose uncertain; inferred from incomplete notes).

## 3) API Endpoints

All endpoints return JSON and use HTTP status codes. Errors: `{"ok": false, "error": "msg"}`. Requests/responses are JSON unless noted.

- **api/add_exercises.php** (POST): Add/update custom exercises.
  - Request: JSON body e.g., `{"id": "snake_case_id", "name": "Exercise Name", "w": {"chest": 0.5}}`.
  - Response: `{"ok": true}` on success.
  - Errors: Validation failures (e.g., invalid id, weights not 0-1).

- **api/exercises_list.php** (GET): List active exercises.
  - Request: None (query params not used).
  - Response: `{"ok": true, "exercises": [{"id": "...", "name": "...", "w": {...}}]}`.
  - Errors: DB query failures.

- **api/get_exercises.php** (GET): Fetch custom exercises.
  - Request: None.
  - Response: Same as `exercises_list.php`.
  - Errors: DB query failures.

- **api/get_logs.php** (GET): Fetch up to 250 recent logs.
  - Request: None.
  - Response: `{"ok": true, "rows": [...]}` (raw DB rows).
  - Errors: DB query failures.

- **api/get_muscle_state.php** (GET): Fetch muscle states.
  - Request: None.
  - Response: `{"ok": true, "rows": [...]}` (raw DB rows).
  - Errors: DB query failures.

- **api/log_workout.php** (POST): Log a workout.
  - Request: JSON body e.g., `{"date": "YYYY-MM-DD", "exercise_id": "id", "exercise_name": "name", "sets": 3, "reps": 10, "stimulus": 0.5, "muscles": {"chest": 0.5}}`.
  - Response: `{"ok": true}`.
  - Errors: Validation failures, exceptions (e.g., invalid fields).

- **api/state_reset.php** (POST): Reset state.
  - Request: None (empty body).
  - Response: `{"ok": true, "deleted_logs": N, "deleted_muscles": M}`.
  - Errors: Transaction failures.

## 4) Frontend Flow

The main page is `index.html`, which loads `main.js` as the entry point. JS modules handle API calls via `fetch`.

- **Pages**: Single page (`index.html`) with canvas (`#view`) and sidebar panels for forms, logs, recommendations.
- **JS Modules and Calls**:
  - On load, `main.js` calls `loadMuscleStateServer()` (fetches from `api/get_muscle_state.php`) and `loadLogsServer()` (from `api/get_logs.php`).
  - Local predictions use `recovery.js` functions like `tickDecay()` and `applyStimulus()` for UI responsiveness.
