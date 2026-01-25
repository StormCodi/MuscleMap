# Developer Manual for MuscleMap Fitness Tracking Project

## Overview

This manual provides a comprehensive guide to the MuscleMap project, a web-based fitness tracking application. It features a 3D muscle viewer for visualizing muscle states, workout logging, exercise recommendations, and an AI-powered intake system for adding custom exercises. The backend uses PHP for API endpoints and MySQL for data storage, while the frontend leverages JavaScript (with Three.js for 3D rendering) and CSS for UI. Dependencies include tools for 3D model processing (e.g., GLTF conversion). This manual is synthesized from analyzed code chunks; elements not present in provided files are noted as "not found in provided files."

## High-Level Architecture Diagram

```
+-------------+     +----------------+     +----------------+     +----------------+
|  UI (HTML)  | --> | JS Modules     | --> | PHP API        | --> | MySQL DB       |
| - index.html|     | - main.js      |     | Endpoints      |     | - Tables:      |
| - ai_intake |     | - lib/*.js     |     | - api/*.php    |     |   exercises,   |
| .html       |     | (e.g.,         |     | (e.g.,         |     |   workout_logs,|
| - style.css |     +----------------+     |  ai_intake_*.php|     |   muscle_state |
+-------------+           |                 +----------------+     +----------------+
                          |                           |                    ^
                          v                           v                    |
                  +----------------+          +----------------+          |
                  | 3D Rendering   |          | AI Provider    |          |
                  | (Three.js)     |          | (xAI API)      |          |
                  +----------------+          +----------------+          |
                          ^                           |                    |
                          |                           v                    |
                          +---------------------------+--------------------+
                                             (Response Flow Back to UI)
```

The flow typically starts from the UI (e.g., form submissions in index.html), handled by JS (e.g., main.js fetches data), calling PHP APIs (e.g., api/log_workout.php), which interact with the DB and optionally AI providers like xAI for chat completions. Responses return to the UI for rendering (e.g., updating 3D model heatmaps).

## 1) Directory/Module Map

- **api/**: Contains PHP backend endpoints and helpers.
  - **add_exercises.php**: Adds/updates custom exercises in DB.
  - **ai_intake_resolve.php**: Resolves AI intake sessions by matching or proposing exercises.
  - **ai_intake_start.php**: Starts new AI intake sessions.
  - **ai_intake_step.php**: Processes steps in AI intake, including prompts and xAI calls.
  - **db.php**: PDO connection utility with hardcoded credentials; defines `GLOBAL_USER_ID=0`.
  - **exercises_list.php**: Fetches active exercises.
  - **get_exercises.php**: Fetches custom exercises.
  - **get_logs.php**: Fetches workout logs.
  - **get_muscle_state.php**: Fetches muscle states.
  - **log_workout.php**: Logs workouts and updates muscle states.
  - **state_reset.php**: Resets user data in DB.
  - **ai_intake/** (subdirectory): AI-specific helpers.
    - **db_intake.php**: DB functions like `intakeVerifySession()`, `intakeInsertUserMessage()`, `intakeLoadExistingExercises()`, `intakeLoadHistory()`, `intakeStoreAssistantMMJ()`.
    - **helpers.php**: Utilities like `jsonFail()`, `stripJsonFences()`, `normName()`, `nameSimilarity()`, `slugSnake()`, `tableHasColumn()`, `tableExists()`.
    - **images.php**: Image handling like `saveSafeImageDataUrlToDisk()`, `storeImagesForMessage()`.
    - **mmj.php**: Prompt building and MMJ processing like `buildSystemPrompt()`, `buildMessages()`, `mmjGuardrailMatchExisting()`, `mmjCleanupProposal()`.
    - **xai.php**: xAI API calls via `xaiChatCompletions()`.

- **lib/**: JavaScript modules for frontend logic.
  - **exercises.js**: Caches/fetches exercises via `getAllExercisesCached()` (TTL=60s), `getExerciseById()`, `bustExercisesCache()`.
  - **muscleMap.js**: Defines muscle groups in `GROUPS` array; classifies meshes with `classifyMeshName()`.
  - **recovery.js**: Simulates muscle state: `ensureMuscle()`, `tickDecay()` (half-life decay), `applyStimulus()`, `computeHeat()`, `isNeglected()`.
  - **recs.js**: Generates recommendations with `generateRecs()` based on heat/overdo/neglect.
  - **storage.js**: LocalStorage wrappers: `loadState()`, `saveState()`, `resetState()` (not used in main.js; state managed via server).

- **Root Files**:
  - **ai_intake.html**: UI for AI exercise intake; handles session start/resolution via POST to APIs.
  - **index.html**: Main UI with 3D viewer, sidebar for logging, recs, logs.
  - **main.js**: Core JS; sets up Three.js, loads GLB models via `loadGLBWithFallback()`, handles picking, fetches data (e.g., `loadMuscleStateServer()`, `loadLogsServer()`), logs workouts via `onLogWorkout()`, renders UI (e.g., `renderRecs()`, `renderLogs()`).
  - **style.css**: Styles UI elements like `.app`, `.viewer`, `.sidebar`, `.panel`, `.btn`, `.legend`, `.recs`, `.logs`; supports mobile-first with desktop media query (min-width: 900px).
  - **package.json**: Project manifest; defines name ("musclemap"), version (1.0.0), main ("main.js"), dependencies (`@gltf-transform/cli` ^4.3.0, `fbx2gltf` ^0.9.7-p1), and placeholder scripts.
  - **package-lock.json**: Lockfile for dependencies; includes transitive deps like `sharp`, `draco3dgltf`, `meshoptimizer`.

## 2) Data Model (Tables + Key Fields)

Only tables and fields inferred from queries in provided files are included. No assumptions about unmentioned elements.

- **ai_intake_sessions**: id (int PK), user_id (int), status (string e.g. 'open'/'done'), last_mmj_json (JSON).
- **ai_intake_messages**: id (int PK), session_id (int FK), role (string e.g. 'user'/'assistant'), text (string), mmj_json (JSON), image_mime (string optional), image_data (BLOB optional), image_path (string optional), image_meta_json (JSON optional).
- **ai_intake_message_images** (inferred, not fully queried): message_id (int FK), rel_path (string), mime (string), meta_json (JSON).
- **exercises**: user_id (int), exercise_key (string unique with user_id), name (string), weights_json (JSON {string: number 0-1}), source (string e.g. 'ai'), is_active (int 1=active), updated_at (timestamp inferred).
- **exercises_custom**: user_id (int), exercise_key (string unique with user_id), name (string), weights_json (JSON {string: number 0-1}), updated_at (timestamp).
- **workout_logs**: id (int PK), user_id (int), workout_date (string 'YYYY-MM-DD'), exercise_id (string), exercise_name (string), sets (int), reps (int), load_lbs (float nullable), stimulus (float), created_at (timestamp).
- **muscle_state**: user_id (int), muscle_group (string unique with user_id), load (field incomplete in notes; partial reference to load_value capped at 1.0).

Other tables/fields (e.g., full schema for muscle state simulation) not found in provided files.

## 3) API Endpoints

Endpoints are PHP-based (api/*.php). All use POST/GET methods; responses are JSON. Errors via functions like `bad()`, `fail()`, `jsonFail()`.

- **api/add_exercises.php** (POST): Adds/updates custom exercises. Request: Array of {exercise_key (snake_case string), name (<=128 chars), weights ({string: number 0-1})}. Response: {success: true}. Errors: Validation failures (e.g., invalid key/name/weights).
- **api/ai_intake_resolve.php** (POST): Resolves session. Request: {session_id, mode ("MATCH_EXISTING" or "PROPOSE_NEW")}. Response: {success: true}. Errors: Invalid session/mode (via `fail()`).
- **api/ai_intake_start.php** (POST): Starts session. Request: Empty. Response: {session_id}. Errors: DB insertion failure.
- **api/ai_intake_step.php** (POST): Processes intake step. Request: {session_id, text, images (optional array)}. Response: Assistant response with MMJ. Errors: Invalid session (via `intakeVerifySession()`), image storage issues.
- **api/exercises_list.php** (GET): Fetches active exercises. Request: None. Response: Array of {id, name, w: weights object}. Errors: DB query failure.
- **api/get_exercises.php** (GET): Fetches custom exercises. Request: None. Response: Array of {id, name, w: weights object}. Errors: DB query failure.
- **api/get_logs.php** (GET): Fetches up to 250 logs. Request: None. Response: Array of log objects. Errors: DB query failure.
- **api/get_muscle_state.php** (GET): Fetches muscle states. Request: None. Response: Array ordered by muscle_group. Errors: DB query failure.
- **api/log_workout.php** (POST): Logs workout. Request: {workout_date, exercise_id, sets, reps, load_lbs (optional), stimulus (computed)}. Response: {success: true}. Errors: Validation failures; caps load_value at 1.0.
- **api/state_reset.php** (POST): Resets data. Request: Empty. Response: {deleted_logs: count, deleted_states: count}. Errors: Transaction failure.

No multi-user permissions; uses `GLOBAL_USER_ID=0`. Edge cases: Image uploads validate mime/data; MMJ processing has guardrails.

## 4) Frontend Flow

Pages: **index.html** (main UI with 3D viewer/sidebar), **ai_intake.html** (AI intake chat). Styled by **style.css** (responsive layout: flex for mobile, grid for desktop >900px).

JS Modules: From lib/ (e.g., exercises.js for caching, muscleMap.js for groups, recovery.js for simulation, recs.js for recommendations, storage.js for local state – though server-managed).

Flow: UI events (e.g., form submit in index.html) trigger JS in main.js (e.g., `onLogWorkout()` calls api/log_workout.php via fetch). Data fetched (e.g., `loadMuscleStateServer()` from api/get_muscle_state.php) updates Three.js scene (e.g., apply heat visuals). AI intake in ai_intake.html uses postJSON to ai_intake_start.php/step.php/resolve.php, updating chat UI (e.g., `updateApproveUI()`). 3D models processed via dependencies like fbx2gltf/@gltf-transform/cli (inferred for GLB loading in main.js via `loadGLBWithFallback()`). No explicit DB/AI flow in Chunk 2 files.

## 5) AI Intake / MMJ Schema Explanation

AI intake uses xAI via `xaiChatCompletions()` in api/ai_intake/xai
