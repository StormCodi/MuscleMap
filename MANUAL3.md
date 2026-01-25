# MuscleMap Developer Manual

## Overview

MuscleMap is a web-based fitness application that visualizes muscle states in a 3D model, logs workouts, provides recovery recommendations, and includes AI-driven exercise intake. It uses a PHP backend for API endpoints, a MySQL database for data storage, JavaScript for frontend logic (including Three.js for 3D rendering), and integrates with xAI for AI processing. Dependencies handle 3D asset processing (e.g., GLTF transformations). This manual is synthesized from analyzed code chunks; elements not present in provided files (e.g., full DB schema, certain tables like `ai_intake_message_images`) are noted as "not found in provided files."

## High-Level Architecture Diagram

```
+----------------+     +----------------+     +----------------+     +----------------+
| Frontend UI    | --> | JS Modules     | --> | PHP API        | --> | MySQL DB       |
| (index.html,   |     | (main.js,      |     | Endpoints      |     | (e.g.,         |
| ai_intake.html)|     | lib/*.js)      |     | (api/*.php)    |     | exercises,     |
| Styled by      |     | Fetches data,  |     | Handles POST/  |     | muscle_state)  |
| style.css      |     | calls APIs     |     | GET, interacts | <-- |                |
+----------------+     +----------------+     | with DB/AI     |     +----------------+
                                       |     +----------------+     |
                                       |                            |
                                       +--> | xAI Provider       | <--+
                                            | (api/ai_intake/*.php)|
                                            +------------------------+
```

- **Flow**: User interacts with UI → JS handles events and API calls → PHP processes requests (e.g., DB queries, AI calls) → Responses update UI. 3D assets are processed via dependencies (e.g., `@gltf-transform/cli`).

## 1) Directory/Module Map

- **api/**: PHP backend endpoints and utilities.
  - `add_exercises.php`: Adds/updates custom exercises.
  - `ai_intake_resolve.php`: Resolves AI intake sessions.
  - `ai_intake_start.php`: Starts AI intake sessions.
  - `ai_intake_step.php`: Processes AI intake steps, calls xAI.
  - `db.php`: PDO connection utility (hardcoded credentials: $DB_HOST="localhost", $DB_NAME="musclemap", GLOBAL_USER_ID=0).
  - `exercises_list.php`: Lists active exercises.
  - `get_exercises.php`: Fetches custom exercises.
  - `get_logs.php`: Fetches workout logs.
  - `get_muscle_state.php`: Fetches muscle states.
  - `log_workout.php`: Logs workouts and updates muscle states.
  - `state_reset.php`: Resets user data.
- **api/ai_intake/**: AI intake helpers.
  - `db_intake.php`: DB functions like `intakeVerifySession()`, `intakeInsertUserMessage()`, `intakeLoadExistingExercises()`, `intakeLoadHistory()`, `intakeStoreAssistantMMJ()`.
  - `helpers.php`: Utilities like `jsonFail()`, `stripJsonFences()`, `normName()`, `nameSimilarity()`, `slugSnake()`, `tableHasColumn()`, `tableExists()`.
  - `images.php`: Image functions like `ensureWritableDir()`, `saveImageDataUrl()`, `storeImagesForMessage()`.
  - `mmj.php`: MMJ processing like `buildSystemPrompt()`, `buildMessages()`, `mmjGuardrailMatchExisting()`, `mmjCleanupProposal()`.
  - `xai.php`: xAI integration via `xaiChatCompletions()`.
- **lib/**: JavaScript modules.
  - `exercises.js`: Caches/fetches exercises (e.g., `getAllExercisesCached()`, `getExerciseById()`, `bustExercisesCache()`).
  - `muscleMap.js`: Defines muscle groups in `GROUPS` array; classifies meshes with `classifyMeshName()`.
  - `recovery.js`: Simulates muscle state (e.g., `ensureMuscle()`, `tickDecay()`, `applyStimulus()`, `computeHeat()`, `isNeglected()`).
  - `recs.js`: Generates recommendations with `generateRecs()`.
  - `storage.js`: LocalStorage wrappers (e.g., `loadState()`, `saveState()`, `resetState()`; not used in main.js).
- **assets/**: Inferred for 3D models (e.g., "./assets/models/body.glb"); processed via dependencies.
- **Root Files**:
  - `ai_intake.html`: UI for AI intake.
  - `index.html`: Main UI with 3D viewer and sidebar.
  - `main.js`: Core JS for Three.js setup, data fetching, UI rendering.
  - `package.json`: Project metadata; dependencies like `@gltf-transform/cli` (^4.3.0) and `fbx2gltf` (^0.9.7-p1) for 3D asset processing; entry point "main.js".
  - `package-lock.json`: Locks dependency versions (includes transitive deps like `sharp`, `draco3dgltf`, `meshoptimizer`).
  - `style.css`: CSS for UI layout (e.g., `.app`, `.viewer`, `.sidebar`, color variables like `--bg: #0b0b0c`).
- `config.php`: Referenced but not found in provided files.

## 2) Data Model (Tables + Key Fields)

Only tables and fields inferred from queries in provided files are included. Full schema is not present; elements like `ai_intake_message_images` table are not found.

- **ai_intake_sessions**: Stores AI intake sessions.
  - `id` (int PK): Unique session ID.
  - `user_id` (int): User identifier.
  - `status` (string): e.g., 'open' or 'done'.
  - `last_mmj_json` (JSON): Last MuscleMap JSON.
- **ai_intake_messages**: Stores messages in AI sessions.
  - `id` (int PK): Unique message ID.
  - `session_id` (int FK): References ai_intake_sessions.id.
  - `role` (string): e.g., 'user' or 'assistant'.
  - `text` (string): Message content.
  - `mmj_json` (JSON): MuscleMap JSON (for assistant responses).
  - `image_mime` (string optional): Image MIME type.
  - `image_data` (BLOB optional): Image binary data.
  - `image_path` (string optional): Image file path.
  - `image_meta_json` (JSON optional): Image metadata.
- **exercises**: Standard exercises.
  - `user_id` (int): User identifier.
  - `exercise_key` (string, unique with user_id): Snake_case key (2-64 chars).
  - `name` (string): Exercise name (<=128 chars).
  - `weights_json` (JSON): Object {string: number 0-1} for muscle weights.
  - `source` (string): e.g., 'ai'.
  - `is_active` (int): 1=active.
- **exercises_custom**: Custom exercises (partial; fields cut off in notes).
  - `user_id` (int): User identifier.
  - Other fields (e.g., exercise_key, name, weights_json) inferred similar to exercises but not explicitly listed beyond user_id.
- **workout_logs**: Workout logs.
  - Fields inferred from queries: workout_date (date), exercise_id (int), sets (int), reps (int), load_lbs (float), stimulus (computed).
- **muscle_state**: Muscle states.
  - `muscle_group` (string): e.g., "abs_upper".
  - `load_value` (float 0-1): Current load (capped at 1.0).
  - `last_trained_at` (datetime): Last training time.

## 3) API Endpoints

All endpoints use JSON; errors via `jsonFail()` (e.g., HTTP 400/500 with message).

- **api/add_exercises.php** (POST): Add/update custom exercises.
  - Request: Array of {exercise_key: string (snake_case 2-64), name: string (<=128), weights: {string: number 0-1}}.
  - Response: {success: true}.
  - Errors: Validation fails (e.g., invalid key/name/weights).
- **api/ai_intake_resolve.php** (POST): Resolve AI session.
  - Request: {session_id: int, mode: "MATCH_EXISTING" or "PROPOSE_NEW", match_id: int (for MATCH), proposal: object (for PROPOSE)}.
  - Response: {success: true}.
  - Errors: Invalid session/mode.
- **api/ai_intake_start.php** (POST): Start AI session.
  - Request: Empty.
  - Response: {session_id: int}.
  - Errors: DB insert fail.
- **api/ai_intake_step.php** (POST): Process AI step.
  - Request: {session_id: int, text: string, images: array of base64 data URLs (optional)}.
  - Response: {mmj: object (cleaned MMJ JSON)}.
  - Errors: Invalid session, xAI failure.
- **api/exercises_list.php** (GET): List active exercises.
  - Request: None.
  - Response: Array of {id: int, name: string, w: {string: number 0-1}}.
  - Errors: DB query fail.
- **api/get_exercises.php** (GET): Fetch custom exercises.
  - Request: None.
  - Response: Array of {id: int, name: string, w: {string: number 0-1}}.
  - Errors: DB query fail.
- **api/get_logs.php** (GET): Fetch recent logs (up to 250).
  - Request: None.
  - Response: Array of log objects.
  - Errors: DB query fail.
- **api/get_muscle_state.php** (GET): Fetch muscle states.
  - Request: None.
  - Response: Array of {muscle_group: string, load_value: float, last_trained_at: datetime}.
  - Errors: DB query fail.
- **api/log_workout.php** (POST): Log workout.
  - Request: {exercise_id: int, sets: int, reps: int, load_lbs: float}.
  - Response: {success: true}.
  - Errors: Invalid input; computes stimulus, updates muscle_state.
- **api/state_reset.php** (POST): Reset data.
  - Request: Empty.
  - Response: {deleted_logs: int, deleted_states: int}.
  - Errors: Transaction fail.

## 4) Frontend Flow

- **Pages**:
  - `index.html`: Main page with #view (Three.js canvas), #logForm (workout form), #selectedBox (muscle info), .legend, #recsBox (recommendations), #logsBox (logs), reset button. Styled by `style.css` (responsive layout: mobile flex, desktop grid at 900px; classes like .hud, .panel, .form).
  - `ai_intake.html`: Chat UI for AI intake; displays bubbles with MMJ JSON.
- **JS Modules and Calls**:
  - `main.js`: Sets up Three.js (scene, camera, controls, lights, grid); loads GLB via `loadGLBWithFallback()`; classifies meshes with `muscleMap.js:classifyMeshName()`; fetches state/logs via GET to `api/get_muscle_state.php` and `api/get_logs.php`; logs via POST to `api/log_workout.php`; renders recs with `recs.js:generateRecs()`,
