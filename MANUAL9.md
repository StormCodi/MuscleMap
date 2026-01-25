# MuscleMap Developer Manual

## Overview
MuscleMap is a web application for tracking workouts, visualizing muscle recovery in a 3D model, and using AI to propose and add exercises. It features a main dashboard (index.html) for logging workouts and viewing muscle states, and an AI chat interface (ai_chat.html) for exercise proposals. The backend uses PHP with MySQL for data persistence, and the frontend leverages Three.js for 3D rendering. Key flows involve client-side JS calling PHP APIs to interact with the database. AI integration is partial in provided files (e.g., api/ai_chat.php is referenced but not found).

## High-Level Architecture Diagram
```
+--------------------+     +---------------------+     +-----------------+
| UI (HTML/CSS)      |     | Frontend JS         |     | PHP API         |
| - index.html       |<--->| - main.js           |<--->| - add_exercises.php |
| - ai_chat.html     |     | - ai_chat.js        |     | - log_workout.php   |
|                    |     | - lib/*.js          |     | - etc.             |
+--------------------+     +---------------------+     +---------+---------+
                                                             |
                                                             v
+--------------------+     +---------------------+     +-----------------+
| Three.js (3D)      |     | Database (MySQL)    |     | AI Provider     |
| - vendor/three/    |<--->| - exercises         |<--->| (not in files)  |
|                    |     | - workout_logs      |     |                 |
+--------------------+     | - muscle_state      |     +-----------------+
                           +---------------------+
```

- **Flow**: UI triggers JS events (e.g., form submit in main.js:onLogWorkout) -> JS calls PHP API (e.g., fetch to api/log_workout.php) -> PHP queries DB (via api/db.php) -> Optional AI call (in ai_chat.js:sendToServer to api/ai_chat.php, but api/ai_chat.php not found) -> Response back to JS -> Update UI/3D model.

## 1) Directory/Module Map
- **ai_chat.css**: Styles for the AI chat interface, including chat bubbles, composer, sidebar preview, and responsive layouts.
- **ai_chat.html**: HTML structure for the AI chat page, including chat log, message composer with image upload, 3D preview sidebar, and debug JSON output. Imports Three.js via importmap.
- **ai_chat.js**: Handles AI chat functionality. Key functions: sendToServer (POST to api/ai_chat.php), acceptProposal (POST to api/add_exercises.php), uploadOneImage (POST to api/ai_upload.php), applyPreviewWeights (updates 3D muscle highlights), renderReplyCard (renders proposal cards). Manages history in localStorage (LS_KEY: "musclemap_ai_chat_v2"). Uses Three.js for 3D preview of proposed exercises.
- **api/add_exercises.php**: PHP endpoint to insert/update exercises in the 'exercises' table. Validates id, name, weights, and source.
- **api/ai_upload.php**: PHP endpoint for uploading images (e.g., for AI proposals). Stores in ./uploads/ai_tmp/ and returns token/url.
- **api/db.php**: Database connection setup using PDO (MySQL). Defines GLOBAL_USER_ID=0 for shared user.
- **api/exercises_list.php**: PHP endpoint to fetch active exercises from 'exercises' table.
- **api/get_exercises.php**: PHP endpoint to fetch exercises from 'exercises_custom' table (similar to exercises_list.php but different table; purpose uncertain, possibly a variant or legacy).
- **api/get_logs.php**: PHP endpoint to fetch recent workout logs from 'workout_logs' table (LIMIT 250).
- **api/get_muscle_state.php**: PHP endpoint to fetch muscle states from 'muscle_state' table.
- **api/log_workout.php**: PHP endpoint to log workouts: inserts into 'workout_logs' and updates 'muscle_state' with load deltas.
- **api/state_reset.php**: PHP endpoint to delete user data from 'workout_logs' and 'muscle_state' tables.
- **index.html**: Main HTML page with 3D viewer, workout log form, selected muscle info, legend, recommendations, and recent logs.
- **lib/exercises.js**: Module for caching and fetching exercises (via api/exercises_list.php). Functions: getAllExercisesCached, getExerciseById, bustExercisesCache.
- **lib/muscleMap.js**: Defines muscle groups (GROUPS array) and classification logic. Functions: classifyMeshName (categorizes meshes as "shell", "gym", or "ignore").
- **lib/recovery.js**: Logic for muscle recovery simulation. Functions: ensureMuscle, tickDecay (decays load over time), applyStimulus, computeHeat (calculates heat/overdo based on load/recency).
- **lib/recs.js**: Generates workout recommendations. Function: generateRecs (suggests based on neglect, overdo, or low heat).
- **lib/storage.js**: LocalStorage helpers for state (unused in main.js; state is server-fetched).
- **main.js**: Core JS for index.html. Handles 3D rendering (Three.js), workout logging (onLogWorkout calls api/log_workout.php), state loading (loadMuscleStateServer, loadLogsServer), heat application (applyHeatToAllMeshes), picking/selection, and UI rendering (renderRecs, renderLogs). Animates with requestAnimationFrame.
- **style.css**: Global styles for layout, forms, buttons, etc. Supports mobile/desktop responsive design.

Note: api/ai_chat.php is referenced in ai_chat.js but not found in provided files.

## 2) Data Model (tables + key fields)
Only tables and fields explicitly mentioned in provided PHP files are included. Schema is inferred from queries; no full CREATE statements found.

- **exercises** (from api/add_exercises.php, api/exercises_list.php):
  - user_id (int, key with exercise_key)
  - exercise_key (string, e.g., "a-z0-9_")
  - name (string)
  - weights_json (JSON string, e.g., {"chest":0.5})
  - source (string, e.g., "user" or "ai")
  - is_active (int, 1=active)
  - updated_at (timestamp, auto-updated)

- **exercises_custom** (from api/get_exercises.php; similar to exercises but separate table):
  - user_id (int)
  - exercise_key (string, as id)
  - name (string)
  - weights_json (JSON string)

- **workout_logs** (from api/get_logs.php, api/log_workout.php):
  - id (int, auto?)
  - user_id (int)
  - workout_date (string, e.g., "YYYY-MM-DD")
  - exercise_id (string)
  - exercise_name (string)
  - sets (int)
  - reps (int)
  - load_lbs (float, nullable)
  - stimulus (float)
  - created_at (timestamp)

- **muscle_state** (from api/get_muscle_state.php, api/log_workout.php):
  - user_id (int, key with muscle_group)
  - muscle_group (string, e.g., "chest")
  - load_value (float, 0-1)
  - last_trained_at (int, unix timestamp)
  - last_ping_at (int, unix timestamp)

Note: No sessions/messages/images tables found. Exercises/logs/muscle_state are present. GLOBAL_USER_ID=0 is hardcoded in api/db.php.

## 3) API Endpoints
All endpoints return JSON. Errors: {"ok":false,"error":"msg"} (HTTP 400/500).

- **/api/add_exercises.php** (POST): Adds/updates exercise.
  - Request: {"id":"key","name":"Name","w":{"chest":0.5},"source":"ai"} (source optional, default "user")
  - Response: {"ok":true}
  - Errors: bad_id, bad_name, bad_weights, empty_weights, server_error

- **/api/ai_upload.php** (POST, multipart/form-data): Uploads image.
  - Request: FormData with "image" file (JPEG/PNG/WEBP, <4.5MB)
  - Response: {"ok":true,"token":"hex","mime":"image/jpeg","url":"./uploads/ai_tmp/token.jpg"}
  - Errors: method_not_allowed (405), missing_image, bad_upload_shape, upload_error, bad_size, too_large (413), bad_image_type (415), base_dir_fail/mkdir_fail/move_fail/write_fail (500)

- **/api/exercises_list.php** (GET): Lists active exercises.
  - Request: None
  - Response: {"ok":true,"exercises":[{"id":"key","name":"Name","w":{"chest":0.5}}]}
  - Errors: server_error (500)

- **/api/get_exercises.php** (GET): Lists custom exercises (from exercises_custom).
  - Request: None
  - Response: {"ok":true,"exercises":[{"id":"key","name":"Name","w":{"chest":0.5}}]}
  - Errors: server_error (500)

- **/api/get_logs.php** (GET): Gets recent logs (LIMIT 250).
  - Request: None
  - Response: {"ok":true,"rows":[{"id":1,"workout_date":"2023-01-01",...}]}
  - Errors: None explicit (assumes DB success)

- **/api/get_muscle_state.php** (GET): Gets muscle states.
  - Request: None
  - Response: {"ok":true,"rows":[{"muscle_group":"chest","load_value":0.5,...}]}
  - Errors: None explicit

- **/api/log_workout.php** (POST): Logs workout, updates muscle_state.
  - Request: {"date":"2023-01-01","exercise_id":"key","exercise_name":"Name","sets":3,"reps":10,"load_lbs":null,"stimulus":0.5,"muscles":{"chest":0.5}}
  - Response: {"ok":true}
  - Errors: Invalid JSON (400), Missing field (400), muscles must be object (400), EXCEPTION/PHP ERROR/FATAL (500)

- **/api/state_reset.php** (POST): Resets user data.
  - Request: Empty body
  - Response: {"ok":true,"deleted_logs":N,"deleted_muscles":M}
  - Errors: EXCEPTION/PHP ERROR/FATAL (500)

Note: /api/ai_chat.php referenced in ai_chat.js but not found.

## 4) Frontend Flow
- **Pages**: index.html (main dashboard with 3D viewer, log form, recs, logs); ai_chat.html (AI chat with composer, 3D preview, debug JSON).
- **JS Modules**: main.js (core logic for index.html: 3D init in loadGLBWithFallback, workout submit in onLogWorkout -> POST api/log_workout.php, state load via loadMuscleStateServer/loadLogsServer -> GET api/get_muscle_state.php/api/get_logs.php, heat in applyHeatToAllMeshes, recs in renderRecs); ai_chat.js (chat handling: submit -> sendToServer POST api/ai_chat.php, upload -> uploadOneImage POST api/ai_upload.php, accept -> acceptProposal POST api/add_exercises.php, 3D preview in applyPreviewWeights); lib/exercises.js (cache via getAllExercisesCached GET api/exercises_list.php); lib/muscleMap.js (group classification); lib/recovery.js (decay/stimulus/heat); lib/recs.js (generateRecs); lib/storage.js (unused).
- **Request/Response Flow (End-to-End)**: UI event (e
