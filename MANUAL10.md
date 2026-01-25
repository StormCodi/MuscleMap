# MuscleMap Developer Manual

## Overview
MuscleMap is a web application for tracking workouts, visualizing muscle recovery, and proposing new exercises via AI. It consists of a frontend (HTML/JS/CSS with Three.js for 3D models) and a backend (PHP APIs interacting with a MySQL database). The main page (`index.html`) allows logging workouts and viewing muscle heatmaps. The AI chat page (`ai_chat.html`) enables describing exercises (with optional images) to an AI for proposals, which can be added to the database. Data flows from UI to JS, to PHP APIs, to DB, and back. AI integration is handled via `ai_chat.php` (not provided in files; assumed external).

## High-Level Architecture Diagram
```
+-------------+     +----------------+     +-------------+     +-----------------+
|  UI (HTML)  | --> | Frontend JS    | --> | PHP API     | --> | MySQL DB        |
| - index.html|     | - main.js      |     | Endpoints   |     | - exercises     |
| - ai_chat   |     | - ai_chat.js   |     | (e.g.,      |     | - workout_logs  |
|             | <-- | - lib/*.js     | <-- | log_workout)| <-- | - muscle_state  |
+-------------+     +----------------+     +-------------+     +-----------------+
                                       |
                                       v
                                 +-------------+
                                 | AI Provider |
                                 | (external)  |
                                 +-------------+
```
- UI interacts with JS for rendering and events.
- JS calls PHP APIs for data ops.
- PHP queries DB; AI chat forwards to external AI.
- Responses flow back to update UI.

## 1) Directory/Module Map
- **ai_chat.css**: Styles for AI chat interface (e.g., .aiShell, .bubble for messages, .preview for 3D muscle preview).
- **ai_chat.html**: HTML structure for AI chat page, including chat log, composer, 3D preview, and debug JSON output.
- **ai_chat.js**: Handles AI chat logic, including message sending to `api/ai_chat.php`, image uploads to `api/ai_upload.php`, exercise addition via `api/add_exercises.php`, 3D preview with Three.js (functions: addBubble, sendToServer, acceptProposal, applyPreviewWeights).
- **api/add_exercises.php**: API to add/update exercises in DB.
- **api/ai_upload.php**: API for uploading images for AI chat.
- **api/db.php**: Database connection setup (PDO to MySQL with global user ID).
- **api/exercises_list.php**: API to list active exercises.
- **api/get_exercises.php**: API to list custom exercises (similar to exercises_list.php but from exercises_custom table).
- **api/get_logs.php**: API to fetch recent workout logs.
- **api/get_muscle_state.php**: API to fetch muscle state (not called in provided JS files).
- **api/log_workout.php**: API to log a workout.
- **api/state_reset.php**: API to reset workout logs.
- **index.html**: Main app HTML with 3D viewer, workout log form, selected muscle info, legend, recommendations, and recent logs.
- **lib/exercises.js**: Utilities for fetching/caching exercises from `api/exercises_list.php` (functions: getAllExercisesCached, getExerciseById, bustExercisesCache).
- **lib/muscleMap.js**: Defines muscle groups and classification for 3D meshes (e.g., GROUPS array, classifyMeshName function).
- **lib/recovery.js**: Logic for muscle load decay and stimulus application (functions: ensureMuscle, tickDecay, applyStimulus, computeHeat, isNeglected).
- **lib/recs.js**: Generates workout recommendations based on recovery state (function: generateRecs).
- **lib/storage.js**: Not used in provided files (localStorage for state; but main.js uses server DB instead).
- **main.js**: Core logic for main app, including 3D rendering, logging workouts via `api/log_workout.php`, fetching logs from `api/get_logs.php`, rebuilding muscle state, and UI updates (functions: loadLogsServer, rebuildMuscleFromLogs, applyHeatToAllMeshes, renderRecs, renderLogs, onLogWorkout).
- **style.css**: Global styles for the app (e.g., .app, .viewer, .sidebar).

## 2) Data Model (tables + key fields)
Only tables and fields explicitly mentioned in provided PHP files are included. No invention of missing elements.

- **exercises** (from add_exercises.php, exercises_list.php):
  - user_id (int, foreign key or filter)
  - exercise_key (string, unique with user_id)
  - name (string)
  - weights_json (JSON, e.g., {"chest": 0.8})
  - source (string, e.g., "user" or "ai")
  - is_active (int, 1 for active)
  - updated_at (timestamp)

- **exercises_custom** (from get_exercises.php; similar to exercises but separate table):
  - user_id (int)
  - exercise_key (string, as id)
  - name (string)
  - weights_json (JSON)

- **workout_logs** (from get_logs.php, log_workout.php, state_reset.php):
  - id (int, primary key)
  - user_id (int)
  - workout_date (date string, e.g., "YYYY-MM-DD")
  - exercise_id (string)
  - exercise_name (string)
  - sets (int)
  - reps (int)
  - load_lbs (float, nullable)
  - stimulus (float)
  - created_at (timestamp)
  - muscles_json (JSON, snapshot of muscle weights)

- **muscle_state** (from get_muscle_state.php; not used in provided JS):
  - user_id (int)
  - muscle_group (string)
  - load_value (float)
  - last_trained_at (timestamp)
  - last_ping_at (timestamp)

No other tables found in provided files (e.g., no sessions/messages/images explicitly; AI chat uses localStorage for history).

## 3) API Endpoints
All endpoints are PHP files under /api/. Details from code.

- **/api/add_exercises.php** (POST):
  - Request JSON: { "id": string (exercise_key), "name": string, "w": object (weights map), "source": string (optional, "user"|"ai") }
  - Response JSON: { "ok": true } on success; { "ok": false, "error": string } on failure (e.g., "bad_id", "bad_name", "empty_weights", "server_error")
  - Errors: 400 for invalid input, 500 for DB errors.

- **/api/ai_upload.php** (POST, multipart/form-data):
  - Request: FormData with "image" file (JPEG/PNG/WEBP, <4.5MB)
  - Response JSON: { "ok": true, "token": string, "mime": string, "url": string } on success; { "ok": false, "error": string, ... } on failure (e.g., "missing_image", "too_large", "bad_image_type")
  - Errors: 400/405/413/415/500 for upload issues.

- **/api/exercises_list.php** (GET):
  - Request: None
  - Response JSON: { "ok": true, "exercises": array of { "id": string, "name": string, "w": object } }; { "ok": false, "error": "server_error" } on failure
  - Errors: 500 for DB errors.

- **/api/get_exercises.php** (GET):
  - Request: None
  - Response JSON: Similar to exercises_list.php but from exercises_custom table.
  - Errors: 500 for DB errors.

- **/api/get_logs.php** (GET? Method not specified, but used as GET in main.js):
  - Request: None
  - Response JSON: { "ok": true, "rows": array of workout_logs rows }
  - Errors: Not explicitly handled in file.

- **/api/get_muscle_state.php** (GET?):
  - Request: None
  - Response JSON: { "ok": true, "rows": array of muscle_state rows }
  - Errors: Not explicitly handled.

- **/api/log_workout.php** (POST):
  - Request JSON: { "date": string, "exercise_id": string, "exercise_name": string, "sets": int, "reps": int, "load_lbs": float|null, "stimulus": float, "muscles": object }
  - Response JSON: { "ok": true } on success; { "ok": false, "error": string } on failure (e.g., "Invalid JSON", "Missing [field]")
  - Errors: 400 for invalid input, 500 for PHP errors (custom error handler).

- **/api/state_reset.php** (POST?):
  - Request: None (empty body)
  - Response JSON: { "ok": true, "deleted_logs": int }; { "ok": false, "error": string } on failure
  - Errors: 500 for DB errors.

Note: /api/ai_chat.php is called in ai_chat.js but not provided in files – say "not found in provided files" for its details.

## 4) Frontend Flow (pages, JS modules, how calls happen)
- **Pages**:
  - index.html: Main app with 3D viewer (#view), workout form (#logForm), selected info (#selectedBox), recs (#recsBox), logs (#logsBox).
  - ai_chat.html: AI interface with chat log (#chatLog), message composer (#composer), 3D preview (#preview), JSON debug (#jsonOut).

- **JS Modules and Flow**:
  - On load (main.js boot()): Fetch exercises (lib/exercises.js getAllExercisesCached -> /api/exercises_list.php), logs (/api/get_logs.php -> loadLogsServer), rebuild muscle state (rebuildMuscleFromLogs using recovery.js functions), render UI (renderExerciseOptions, renderLogs, renderRecs), load 3D model (loadGLBWithFallback using Three.js).
  - Workout logging: Form submit -> onLogWorkout -> computeStimulus -> POST to /api/log_workout.php -> reload logs -> rebuild state -> update UI/3D heat (applyHeatToAllMeshes).
  - AI chat (ai_chat.js): User sends message/images -> upload images (/api/ai_upload.php -> onPickImages) -> POST to /api/ai_chat.php (sendToServer) -> render reply (renderReplyCard) -> Accept proposal -> POST to /api/add_exercises.php (acceptProposal) -> update history (localStorage LS_KEY) and 3D preview (applyPreviewWeights).
  - 3D interaction: Pointer events in main.js/ ai_chat.js -> raycast to meshes -> setSelected/applyHeatToMesh using muscleMap.js classifyMeshName and recovery.js computeHeat.
  - Recs: Button click -> rebuildMuscleFromLogs -> generateRecs (recs.js) -> render.

## 5) AI Intake / MMJ schema explanation (if present)
AI intake is handled in ai_chat.js/ai_chat.html, proposing exercises via /api/ai_chat.php (not provided). Proposals are JSON objects with type (e.g., "propose_add", "propose_add_many"), including:
- proposal/proposals: array of { name: string, exercise_key: string, confidence: float (0-1), weights: object (muscle group IDs to 0-1 floats, e.g., {"chest": 0.8}) }.
Rendered in renderReplyCard, previewed in 3D
