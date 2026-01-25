# MuscleMap Developer Manual

## Overview

MuscleMap is a web application for tracking workouts and visualizing muscle recovery using a 3D model. It features a frontend with Three.js for rendering, JavaScript for logic, and a PHP backend with MySQL for data persistence. The app allows logging workouts, viewing muscle states, and generating recommendations based on training data. All users share a global user ID (0) for simplicity.

## High-Level Architecture Diagram

```
+-------------+     +----------------+     +-------------+     +----------+
| UI          |     | JS Modules     |     | PHP API     |     | MySQL DB |
| (index.html)|<--->| (main.js, lib/*)|<--->| (api/*.php) |<--->| (musclemap)|
+-------------+     +----------------+     +-------------+     +----------+
                  Calls API endpoints             Queries tables
                  (fetch)                        (PDO)
```

- **UI**: Renders 3D model and forms.
- **JS**: Handles state, recovery calculations, API calls.
- **PHP**: Processes requests, interacts with DB.
- **DB**: Stores exercises, logs, muscle states.

## 1) Directory/Module Map

- **api/**: PHP backend endpoints.
  - `add_exercises.php`: Adds or updates custom exercises (function: `bad` for error handling).
  - `db.php`: Database connection setup (defines `GLOBAL_USER_ID` as 0).
  - `exercises_list.php`: Lists active exercises.
  - `get_exercises.php`: Retrieves custom exercises.
  - `get_logs.php`: Fetches recent workout logs.
  - `get_muscle_state.php`: Gets muscle state data.
  - `log_workout.php`: Logs a workout and updates muscle states.
  - `state_reset.php`: Resets logs and muscle states for the global user.
- **lib/**: JavaScript modules.
  - `exercises.js`: Fetches and caches exercise lists (functions: `fetchList`, `getAllExercisesCached`, `getExerciseById`, `bustExercisesCache`).
  - `muscleMap.js`: Maps 3D mesh names to muscle groups (constants: `GROUPS`; functions: `hasAny`, `classifyMeshName`).
  - `recovery.js`: Handles muscle recovery logic (functions: `clamp01`, `hours`, `ensureMuscle`, `tickDecay`, `applyStimulus`, `computeHeat`, `isNeglected`).
  - `recs.js`: Generates training recommendations (function: `generateRecs`).
  - `storage.js`: Manages local storage (functions: `loadState`, `saveState`, `resetState`, `makeDefaultState`, `normalizeState`). Note: Not used in main.js; state is managed in memory and synced via API.
- **assets/models/**: Referenced for GLB models (e.g., `body.glb`, `body.draco.glb`), but files not provided.
- `index.html`: Main page with UI elements (e.g., #view, #logForm, #exerciseSelect).
- `main.js`: Core frontend logic (imports from lib/*; functions: `apiJson`, `loadMuscleStateServer`, `loadLogsServer`, `applyClassification`, `applyHeatToMesh`, `applyHeatToAllMeshes`, `renderRecs`, `renderLogs`, `onLogWorkout`, `resetStateServer`, `boot`, `animate`).
- `style.css`: CSS styles for UI.
- `vendor/three/**`: Three.js library (imported via importmap in index.html).

## 2) Data Model (tables + key fields)

Tables and fields are inferred from SQL queries in PHP files. Only these are present:

- **exercises_custom**:
  - `user_id`: Integer, user identifier (uses GLOBAL_USER_ID=0).
  - `exercise_key`: String, unique ID for exercise (e.g., "bench_press").
  - `name`: String, exercise name.
  - `weights_json`: JSON, muscle group weights (e.g., {"chest": 1.0}).
  - `updated_at`: Timestamp, last update time (set to CURRENT_TIMESTAMP on update).
  - Primary key: Likely (user_id, exercise_key) based on ON DUPLICATE KEY UPDATE in add_exercises.php.

- **exercises**:
  - `user_id`: Integer.
  - `exercise_key`: String (aliased as id).
  - `name`: String.
  - `weights_json`: JSON.
  - `is_active`: Integer (filtered to 1 in exercises_list.php).
  - Note: May overlap with exercises_custom; exact relation unclear.

- **workout_logs**:
  - `id`: Integer, log ID.
  - `user_id`: Integer.
  - `workout_date`: String (e.g., "2023-10-01").
  - `exercise_id`: String, references exercise_key.
  - `exercise_name`: String.
  - `sets`: Integer.
  - `reps`: Integer.
  - `load_lbs`: Float (nullable).
  - `stimulus`: Float, computed training intensity.
  - `created_at`: Timestamp.

- **muscle_state**:
  - `user_id`: Integer.
  - `muscle_group`: String (e.g., "chest").
  - `load_value`: Float (0..1, capped at 1.0).
  - `last_trained_at`: Integer (Unix timestamp).
  - `last_ping_at`: Integer (Unix timestamp, often 0).

No other tables (e.g., sessions, messages, images, logs beyond workout_logs) found in provided files.

## 3) API Endpoints

All endpoints return JSON and use GLOBAL_USER_ID=0.

- **/api/add_exercises.php** (POST):
  - Request JSON: { "id": string (snake_case, 2-64 chars), "name": string (1-128 chars), "w": object (muscle_group: float 0-1) }.
  - Response JSON: { "ok": true } or { "ok": false, "error": string }.
  - Errors: 400 (bad_id, bad_name, bad_weights, empty_weights, invalid_json); 500 (server_error).

- **/api/exercises_list.php** (GET):
  - Request: None.
  - Response JSON: { "ok": true, "exercises": array of { "id": string, "name": string, "w": object } } or { "ok": false, "error": "server_error" }.
  - Errors: 500 (server_error).

- **/api/get_exercises.php** (GET):
  - Request: None.
  - Response JSON: { "ok": true, "exercises": array of { "id": string, "name": string, "w": object } } or { "ok": false, "error": "server_error" }.
  - Errors: 500 (server_error).

- **/api/get_logs.php** (GET):
  - Request: None.
  - Response JSON: { "ok": true, "rows": array of workout_logs fields }.
  - Errors: None explicit; assumes 200 on success.

- **/api/get_muscle_state.php** (GET):
  - Request: None.
  - Response JSON: { "ok": true, "rows": array of muscle_state fields }.
  - Errors: None explicit; assumes 200 on success.

- **/api/log_workout.php** (POST):
  - Request JSON: { "date": string, "exercise_id": string, "exercise_name": string, "sets": int, "reps": int, "load_lbs": float|null, "stimulus": float, "muscles": object (muscle_group: float) }.
  - Response JSON: { "ok": true } or { "ok": false, "error": string }.
  - Errors: 400 (Invalid JSON, Missing [field], muscles must be an object map); 500 (EXCEPTION/PHP ERROR/FATAL, server errors via handlers).

- **/api/state_reset.php** (POST, body ignored):
  - Request: None.
  - Response JSON: { "ok": true, "deleted_logs": int, "deleted_muscles": int } or { "ok": false, "error": string }.
  - Errors: 500 (EXCEPTION/PHP ERROR/FATAL, transaction errors).

## 4) Frontend Flow (pages, JS modules, how calls happen)

- **Pages**: Single page (index.html) with Three.js viewer (#view), workout form (#logForm), selected muscle display (#selectedBox), recommendations (#recsBox), logs (#logsBox), and buttons (#recsBtn, #resetBtn).
- **JS Modules**: main.js orchestrates; imports from lib/* (exercises.js for caching, muscleMap.js for grouping, recovery.js for state, recs.js for recommendations, storage.js unused in provided code).
- **Request/Response Flow**:
  - UI loads -> main.js boot() calls loadLogsServer() (GET /api/get_logs.php) and loadMuscleStateServer() (GET /api/get_muscle_state.php) to populate state.
  - Form submit (#logForm) -> onLogWorkout() in main.js -> computes stimulus via computeStimulus() -> predicts local state with tickDecay() and applyStimulus() from recovery.js -> POST to /api/log_workout.php -> reloads from server via loadLogsServer() and loadMuscleStateServer() -> renders via renderLogs(), renderRecs(), applyHeatToAllMeshes().
  - Recs button (#recsBtn) -> tickDecay() and renderRecs() (local, no API).
  - Reset button (#resetBtn) -> resetStateServer() (POST /api/state_reset.php) -> resets local state.
  - Exercise select -> renderExerciseOptions() calls getAllExercisesCached() from exercises.js (GET /api/exercises_list.php).
  - 3D interactions: classifyMeshName() from muscleMap.js on model load; computeHeat() from recovery.js for visuals; animate() loop ticks decay every 2s.
  - No DB -> AI provider flow found; all processing is local or DB-based.

## 5) AI Intake / MMJ schema explanation (if present)

Not found in provided files. No AI provider, MMJ schema, or related code present.

## 6) How to Extend

- **Adding an Exercise**: Send POST to /api/add_exercises.php with {id, name, w} (e.g., via curl or custom UI). This upserts into exercises_custom. To list, call /api/exercises_list.php (filters is_active=1; add to exercises table manually if needed). In JS, call bustExercisesCache() from exercises.js and rerender options via renderExerciseOptions() in main.js.
- **Adding a Muscle Group**: Edit GROUPS array in lib/muscleMap.js (add {id, label, tokens, kind}). Update classifyMeshName() if needed. Ensure 3D model meshes match tokens. Reload app to apply; affects recovery.js (e.g., ensureMuscle()) and recs.js (generateRecs()).
- **Adding a New Endpoint**: Create a new PHP file in api/ (e.g., new_endpoint.php). Include require __DIR__ . "/db.php"; for $pdo. Handle JSON input with file_get_contents("php://input") and json_decode(). Use prepared statements for DB. Return JSON with "ok": true/false. In JS (main.js), add a constant (e.g., API_NEW = "./api/new_endpoint.php") and a function to call via apiJson().

## 7) Troubleshooting

- **Common Errors**:
  - API: "invalid_json", "bad_id" (invalid exercise ID), "bad_name", "
