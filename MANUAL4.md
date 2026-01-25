# MuscleMap Developer Manual

## Overview

MuscleMap is a web-based application for tracking workouts, visualizing muscle states in 3D, and recommending exercises. It includes a core frontend with Three.js for 3D rendering, backend PHP endpoints for data management, and an AI-driven intake system for adding exercises via natural language or images. The project uses MySQL for persistence, supports 3D model processing (FBX to GLTF conversion and optimization), and features responsive styling. This manual synthesizes documentation from project notes, focusing on architecture, data models, APIs, flows, and extension guides. Note: Some details (e.g., exact 3D processing scripts) are inferred from dependencies; label uncertainties where applicable.

## High-Level Architecture Diagram

```
+-------------------+     +-------------------+     +-------------------+
| Frontend (Client) |     | Backend (Server)  |     | Database (MySQL)  |
| - index.html      |     | - PHP Endpoints   |     | - Tables:         |
| - ai_intake.html  |<--->|   - api/*.php     |<--->|   exercises       |
| - main.js         |     |   - ai_intake/*.php|     |   exercises_custom|
| - lib/*.js        |     | - Utilities (db.php)|     |   ai_intake_*     |
| - style.css       |     |                   |     |   workout_logs    |
| - Three.js Viewer |     |                   |     |   muscle_state    |
+-------------------+     +-------------------+     +-------------------+
          |                           ^
          |                           |
          +---------------------------+
          | 3D Asset Processing (Build-Time) |
          | - fbx2gltf                      |
          | - @gltf-transform/cli           |
          +---------------------------------+
```

- **Frontend**: Handles UI, 3D rendering, and API calls.
- **Backend**: PHP scripts manage API logic, AI integration (xAI API), and DB interactions via PDO.
- **Database**: Stores exercises, sessions, logs, and states.
- **3D Processing**: Build-time tools convert/optimize models for web use (uncertain: exact invocation scripts not detailed in notes).

## 1) Directory/Module Map

- **Root**:
  - `index.html`: Main app page with Three.js viewer, workout logging, recommendations, and logs.
  - `ai_intake.html`: AI-driven exercise intake UI with chat interface (removable for non-AI core).
  - `style.css`: Core stylesheet for responsive UI, themes, and components (e.g., `.viewer`, `.sidebar`).
  - `package.json`: Project config (name: "musclemap", version: "1.0.0", main: "main.js", dependencies: @gltf-transform/cli@^4.3.0, fbx2gltf@^0.9.7-p1).
  - `package-lock.json`: Dependency lockfile for reproducible installs.
  - `MANUAL.md` / `MANUAL2.md`: Documentation files (this manual synthesizes them).

- **api/**:
  - `db.php`: Shared MySQL PDO connection utility (hardcoded credentials, defines GLOBAL_USER_ID=0).
  - `add_exercises.php`: POST endpoint for adding/updating custom exercises (not exclusively AI).
  - `exercises_list.php`: GET endpoint for fetching active exercises.
  - `get_exercises.php`: GET endpoint for fetching custom exercises.
  - `get_logs.php`: GET endpoint for workout logs.
  - `get_muscle_state.php`: GET endpoint for muscle states.
  - `log_workout.php`: POST endpoint for logging workouts.
  - `state_reset.php`: Endpoint for resetting muscle states (method uncertain: likely POST).
  - `ai_intake_start.php`: POST endpoint for starting AI sessions.
  - `ai_intake_step.php`: POST endpoint for AI session steps.
  - `ai_intake_resolve.php`: POST endpoint for resolving AI sessions.
  - `ai_intake/` (subdirectory):
    - `db_intake.php`: DB utilities (e.g., intakeVerifySession(), intakeInsertUserMessage(), intakeLoadExistingExercises(), intakeLoadHistory(), intakeStoreAssistantMMJ()).
    - `helpers.php`: Utility functions (e.g., jsonFail(), stripJsonFences(), normName(), nameSimilarity(), slugSnake(), tableHasColumn(), tableExists()).
    - `images.php`: Image handling (e.g., ensureWritableDir(), saveImageDataUrl(), storeImagesForMessage()).
    - `mmj.php`: Prompt building and MMJ processing (e.g., buildSystemPrompt(), buildMessages(), mmjGuardrailMatchExisting(), mmjCleanupProposal()).
    - `xai.php`: xAI API integration (e.g., xaiChatCompletions()).

- **lib/**:
  - `exercises.js`: JS for caching/fetching exercises from exercises_list.php.
  - `muscleMap.js`: JS for muscle grouping.
  - `recovery.js`: JS for recovery simulation.
  - `recs.js`: JS for recommendations.
  - `storage.js`: JS for localStorage management.

- **Other (Inferred)**: 3D models (e.g., FBX/GLTF files processed via dependencies; exact paths uncertain).

**Note on Removing AI Components**: To reset the AI exercise intake while keeping the core project functional, safely remove: `ai_intake.html`, `api/ai_intake_start.php`, `api/ai_intake_step.php`, `api/ai_intake_resolve.php`, and the entire `api/ai_intake/` subdirectory (db_intake.php, helpers.php, images.php, mmj.php, xai.php). The `api/add_exercises.php` can remain as it's not AI-exclusive. Core endpoints (e.g., exercises_list.php, log_workout.php) and frontend (index.html, main.js) will continue working without AI dependencies. Update any references in main.js or index.html if they link to AI (uncertain: notes indicate no direct calls).

## 2) Data Model (tables + key fields)

Only tables mentioned in notes are included.

- **exercises**: Stores standard exercises.
  - `id`: string (snake_case key, PK).
  - `name`: string (<=128 chars).
  - `w`: JSON { [muscle_group: string]: number (0-1) } (weights).

- **exercises_custom**: Stores user-custom exercises.
  - Similar to exercises: `id` (string), `name` (string), `weights` (JSON).

- **ai_intake_sessions**: AI session tracking.
  - `id`: int (PK).
  - `user_id`: int.
  - `status`: string (e.g., 'open', 'done').
  - `last_mmj_json`: JSON.

- **ai_intake_messages**: AI message history.
  - `id`: int (PK).
  - `session_id`: int (FK to ai_intake_sessions).
  - `role`: string (e.g., 'user', 'assistant').
  - `text`: string.
  - `mmj_json`: JSON.
  - `image_mime`: string (optional).
  - `image_data`: BLOB (optional).
  - `image_path`: string (optional).
  - `image_meta_json`: JSON (optional).

- **workout_logs**: Workout history.
  - `id`: int (PK).
  - `user_id`: int.
  - `workout_date`: string ('YYYY-MM-DD').
  - `exercise_id`: string.
  - `exercise_name`: string.
  - `sets`: int.
  - `reps`: int.
  - `load_lbs`: float (nullable).
  - `stimulus`: float.
  - `created_at`: timestamp.

- **muscle_state**: Muscle recovery states.
  - `user_id`: int.
  - `muscle_group`: string (unique with user_id).
  - `load_value`: float (0-1).
  - `last_trained_at`: int (Unix timestamp).
  - `last_ping_at`: int (Unix timestamp).

## 3) API Endpoints

- **GET /api/exercises_list.php**: Fetches active exercises. Response: JSON array of Exercise Objects { "id": string, "name": string, "w": { [muscle_group]: number } }. Errors: JSON { "error": string }.

- **GET /api/get_exercises.php**: Fetches custom exercises. Response: Similar to above.

- **POST /api/add_exercises.php**: Adds/updates custom exercises. Request: JSON { "id": string, "name": string, "weights": JSON }. Response: JSON { "ok": true }. Errors: JSON fail via jsonFail().

- **GET /api/get_logs.php**: Fetches workout logs. Response: JSON array from workout_logs. Errors: Uncertain (likely JSON error).

- **GET /api/get_muscle_state.php**: Fetches muscle states. Response: JSON from muscle_state. Errors: Uncertain.

- **POST /api/log_workout.php**: Logs a workout. Request: Uncertain (likely JSON with sets, reps, etc.). Response: JSON { "ok": true }. Errors: Uncertain.

- **(Method Uncertain) /api/state_reset.php**: Resets muscle states. Response: Uncertain.

- **POST /api/ai_intake_start.php**: Starts AI session. Request: Empty or user_id. Response: JSON { "session_id": int }. Errors: JSON fail.

- **POST /api/ai_intake_step.php**: Processes AI step. Request: JSON { "session_id": int, "text": string, "image_data_url": string (base64, optional) or "image_data_urls": array }. Response: JSON with MMJ (see schema). Errors: JSON fail via jsonFail().

- **POST /api/ai_intake_resolve.php**: Resolves AI session. Request: Uncertain (mode like "MATCH_EXISTING"). Response: JSON { "ok": true, "mode": "match" | "new", "exercise": { "id": string, "name": string } }. Errors: JSON fail.

## 4) Frontend Flow

- **Pages**:
  - `index.html`: Main page with Three.js viewer (.viewer), sidebar (.sidebar), workout form, recommendations (.recs), logs (.logs), and legend (.legend).
  - `ai_intake.html`: AI intake page with chat bubbles for messages and MMJ rendering.

- **JS Modules**:
  - `main.js`: Core logic for Three.js rendering, model loading, UI events (e.g., logging via log_workout.php), state management, fetching exercises via exercises.js.
  - `lib/exercises.js`: Caches/fetches exercises from exercises_list.php; populates selects in index.html.
  - `lib/muscleMap.js`: Handles muscle grouping for 3D mapping.
  - `lib/recovery.js`: Simulates recovery for states.
  - `lib/recs.js`: Generates recommendations.
  - `lib/storage.js`: Manages localStorage.

- **Call Flow**:
  - On load (index.html): main.js fetches muscle state (get_muscle_state.php), exercises (exercises_list.php via exercises.js), logs (get_logs.php). Renders 3D model, updates UI (e.g., color-coded muscles via style.css variables).
  - Workout logging: Form submit → main.js POST to log_workout.php → Refresh state/logs.
  - AI intake (ai_intake.html): Start session (POST ai_intake_start.php) → User input → POST ai_intake_step.php (handles images/text) → Render chat/MMJ → Resolve (POST ai_intake_resolve.php) adds exercise, integrable to main flow via exercises_list.php.
  - Responsive: style.css uses media queries (min-width: 900px) for mobile (flex column) vs. desktop (grid).

##
