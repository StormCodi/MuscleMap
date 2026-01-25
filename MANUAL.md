# Developer Manual for Fitness Tracking Project

## Overview

This manual documents a web-based fitness tracking application that allows users to log workouts, track muscle recovery states, visualize muscle heatmaps using Three.js, and add exercises via an AI intake process powered by xAI. The backend uses PHP for API endpoints interacting with a MySQL database, while the frontend leverages JavaScript for UI logic and CSS for styling. The app supports custom exercises, workout logging, and AI-driven exercise proposals. This manual is synthesized from analyzed code chunks; elements not present in the provided notes (e.g., full DB schema details or certain modules) are noted as "not found in provided files."

## High-Level Architecture Diagram

```
+----------------+     +----------------+     +----------------+     +----------------+
|    Frontend    |     |  JavaScript    |     |   PHP API      |     |   MySQL DB     |
| (index.html,   |<--->| (main.js,      |<--->| (api/*.php)    |<--->| (tables:       |
| ai_intake.html)|     | lib/*.js)      |     |                |     | exercises,     |
| + style.css    |     | Fetches data   |     | Handles reqs,  |     | muscle_state,  |
+----------------+     | via API calls  |     | DB queries,    |     | workout_logs,  |
                       +----------------+     | xAI integration|     | etc.)          |
                                              +----------------+     +----------------+
                                                             ^
                                                             |
                                                             +----------------+
                                                             |   AI Provider  |
                                                             |   (xAI API)    |
                                                             +----------------+

Flow: UI (e.g., form submit) -> JS (e.g., fetch to API) -> PHP (e.g., validate, DB insert/query, call xAI) -> DB/AI -> Response back to UI for rendering (e.g., update Three.js scene).
```

## 1) Directory/Module Map

This section maps key files and modules based on the analyzed chunks. Only files explicitly mentioned are included.

- **api/add_exercises.php**: PHP endpoint for adding/updating custom exercises in the `exercises_custom` table.
- **api/ai_intake_resolve.php**: PHP endpoint for resolving AI intake sessions, handling modes like "MATCH_EXISTING" or "PROPOSE_NEW" by updating `exercises` or linking exercises.
- **api/ai_intake_start.php**: PHP endpoint for creating new AI intake sessions in `ai_intake_sessions`.
- **api/ai_intake_step.php**: PHP endpoint for processing AI intake steps, including message storage, prompt building, xAI calls, and MMJ processing.
- **api/db.php**: PHP utility for MySQL PDO connection (hardcoded credentials) and defines GLOBAL_USER_ID=0.
- **api/exercises_list.php**: PHP endpoint to fetch active exercises from `exercises`.
- **api/get_exercises.php**: PHP endpoint to fetch custom exercises from `exercises_custom`.
- **api/get_logs.php**: PHP endpoint to fetch recent workout logs from `workout_logs`.
- **api/get_muscle_state.php**: PHP endpoint to fetch muscle states from `muscle_state`.
- **api/log_workout.php**: PHP endpoint for logging workouts to `workout_logs` and updating `muscle_state`.
- **api/state_reset.php**: PHP endpoint for resetting user data in `workout_logs` and `muscle_state`.
- **lib/exercises.js**: JS module for caching and fetching exercises via `getAllExercisesCached()` and `getExerciseById()`.
- **lib/muscleMap.js**: JS module defining muscle groups and classifying GLB mesh names (e.g., into "shell", "gym", "ignore").
- **lib/recovery.js**: JS module for managing muscle state, with functions like `ensureMuscle()`, `tickDecay()`, `applyStimulus()`, `computeHeat()`, `isNeglected()`.
- **lib/recs.js**: JS module for generating recommendations based on muscle heat and neglect.
- **lib/storage.js**: JS module for localStorage handling (e.g., `loadState()`, `saveState()`, `resetState()`); note: not used in main.js, state managed via server APIs.
- **main.js**: Core JS for Three.js app, handling model loading (body.glb), mesh classification, UI wiring, API fetches (e.g., get_logs.php, log_workout.php), and rendering logs/recommendations.
- **style.css**: CSS stylesheet for UI layout, theming, and responsiveness (e.g., flex/grid for .app, .viewer, .sidebar; media queries at 900px).
- **ai_intake.html**: HTML page for AI exercise intake UI, handling sessions and interactions with ai_intake_*.php endpoints.
- **index.html**: Main HTML page with Three.js viewer, sidebar for workouts, muscle info, legends, recommendations, and logs.

Other directories/modules (e.g., api/images.php, api/mmj.php, api/xai.php, api/db_intake.php) are inferred from dependencies but not fully detailed in notes.

## 2) Data Model (Tables + Key Fields)

The data model is inferred from queries in the provided files; full schema not explicitly defined. Only tables and fields appearing in notes are included.

- **ai_intake_sessions**: Stores AI intake sessions.
  - id (int, PK): Unique session identifier.
  - user_id (int): User identifier (e.g., GLOBAL_USER_ID=0).
  - status (string): e.g., 'open', 'done'.
  - last_mmj_json (JSON): Last MuscleMap JSON response.

- **ai_intake_messages**: Stores messages in AI sessions.
  - id (int, PK): Unique message identifier.
  - session_id (int): Foreign key to ai_intake_sessions.
  - role (string): e.g., 'user', 'assistant'.
  - text (string): Message content.
  - mmj_json (JSON): MuscleMap JSON (if assistant).
  - image_mime (string, optional): Image MIME type.
  - image_data (BLOB, optional): Image binary data.
  - image_path (string, optional): Image file path.
  - image_meta_json (JSON, optional): Image metadata.

- **ai_intake_message_images** (inferred, not fully queried): Stores image attachments.
  - message_id (int): Foreign key.
  - rel_path (string): Relative path.
  - mime (string): MIME type.
  - meta_json (JSON): Metadata.

- **exercises**: Stores standard exercises.
  - user_id (int): User identifier.
  - exercise_key (string, unique with user_id): Unique key.
  - name (string): Exercise name.
  - weights_json (JSON): Muscle weights { [muscle_group: string]: number (0-1) }.
  - source (string): e.g., 'ai'.
  - is_active (int): 1=active.

- **exercises_custom**: Stores custom exercises.
  - user_id (int): User identifier.
  - exercise_key (string, unique with user_id): Unique key.
  - name (string): Exercise name.
  - weights_json (JSON): Muscle weights { [muscle_group: string]: number (0-1) }.
  - updated_at (timestamp): Last update time.

- **workout_logs**: Stores workout logs.
  - id (int, PK): Unique log identifier.
  - user_id (int): User identifier.
  - workout_date (string): e.g., 'YYYY-MM-DD'.
  - exercise_id (string): Exercise key.
  - exercise_name (string): Exercise name.
  - sets (int): Number of sets.
  - reps (int): Number of reps.
  - load_lbs (float, nullable): Load in pounds.
  - stimulus (float): Stimulus value.
  - created_at (timestamp): Creation time.

- **muscle_state**: Stores muscle recovery states.
  - user_id (int): User identifier.
  - muscle_group (string, unique with user_id): Muscle group name.
  - load_value (float, 0-1): Current load (capped at 1.0).
  - last_trained_at (int): Unix timestamp of last training.
  - last_ping_at (int): Unix timestamp of last ping.

Other tables/fields not found in provided files.

## 3) API Endpoints

Endpoints are PHP-based; methods inferred as POST for mutations (e.g., add/log) and GET for queries. Request/response JSON and errors from notes.

- **api/add_exercises.php** (POST): Adds/updates custom exercises.
  - Request: { id: string, name: string, weights: { [muscle: string]: number } }.
  - Response: { ok: true } or error JSON.
  - Errors: Validation failures (e.g., invalid weights).

- **api/ai_intake_resolve.php** (POST): Resolves AI session.
  - Request: Session ID and mode data.
  - Response: { mode: string, exercise: { id, name, weights } }.
  - Errors: Invalid mode or verification failure.

- **api/ai_intake_start.php** (POST): Starts new session.
  - Request: None (or user data).
  - Response: { session_id: int }.
  - Errors: DB insert failure.

- **api/ai_intake_step.php** (POST): Processes AI step.
  - Request: { session_id: int, text: string, images: array (optional) }.
  - Response: MMJ JSON.
  - Errors: Invalid session, xAI call failure.

- **api/exercises_list.php** (GET): Lists active exercises.
  - Request: None.
  - Response: Array of { id: string, name: string, w: { [muscle: string]: number } }.
  - Errors: DB query failure.

- **api/get_exercises.php** (GET): Lists custom exercises.
  - Request: None.
  - Response: Similar to exercises_list.php.
  - Errors: DB query failure.

- **api/get_logs.php** (GET): Fetches recent logs (up to 250).
  - Request: None.
  - Response: { ok: true, rows: array of log objects }.
  - Errors: DB query failure.

- **api/get_muscle_state.php** (GET): Fetches muscle states.
  - Request: None.
  - Response: { ok: true, rows: array of state objects }.
  - Errors: DB query failure.

- **api/log_workout.php** (POST): Logs workout and updates state.
  - Request: { workout_date, exercise_id, exercise_name, sets, reps, load_lbs, stimulus }.
  - Response: { ok: true }.
  - Errors: Missing fields, validation failures.

- **api/state_reset.php** (POST): Resets user data.
  - Request: None.
  - Response: { deleted_logs: int, deleted_states: int }.
  - Errors: DB delete failure.

Invariants/Edge Cases: All endpoints use GLOBAL_USER_ID=0 (shared user, no real permissions). Validation: Weights cleaned to 0-1 floats, snake_case keys. Edge cases: Invalid JSON, image upload failures (e.g., MIME checks), session status checks (e.g., must be 'open'). Error codes: Generic JSON errors (e.g., { error: string }).

## 4) Frontend Flow

- **Pages**:
  - **index.html**: Main page with Three.js viewer (.viewer), sidebar (.sidebar) for forms, legends (.legend), recommendations (.recs), and logs (.logs). Responsive via style.css (mobile column to desktop grid at 900px).
  - **ai_intake.html**: AI intake page with chat UI for sending text/images, displaying MMJ, and approving proposals.

- **JS Modules and Calls**:
  -
