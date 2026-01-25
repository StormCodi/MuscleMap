# MuscleMap Project Developer Manual

## Overview
MuscleMap is a web application for tracking workouts, visualizing muscle recovery and load via a 3D heatmap, and providing workout recommendations. It includes core features for logging exercises, managing muscle states, and optional AI-driven exercise intake using xAI/Grok. The app uses a frontend with Three.js for 3D rendering, JavaScript for logic, and a PHP backend with MySQL for data persistence. This manual covers the architecture, modules, data models, APIs, flows, extensions, and troubleshooting.

## High-Level Architecture Diagram
```
+-------------------+     +-------------------+     +-------------------+
|     Frontend      |     |     Backend APIs  |     |     Database      |
| - index.html      |<--->| - PHP Endpoints   |<--->| - MySQL Tables    |
| - main.js         |     |   (e.g., log_workout.php) | - workout_logs    |
| - lib/*.js        |     | - db.php (PDO)    |     | - muscle_state    |
| - ai_intake.html  |     | - AI Intake APIs  |     | - exercises       |
|   (optional AI)   |     |   (optional)      |     | - ai_intake_sessions|
+-------------------+     +-------------------+     +-------------------+
          |                          ^
          v                          |
+-------------------+                |
| 3D Rendering      |                |
| - Three.js        |                |
| - GLB Models      |                |
+-------------------+                |
                                     |
                          +-------------------+
                          | External Services |
                          | - xAI API (optional)|
                          +-------------------+
```

## 1) Directory/Module Map
- **index.html**: Main entry point for the web app. Renders the UI including 3D viewer, workout logging form, recommendations panel, and recent logs display. Imports `main.js` for logic.
- **main.js**: Core JavaScript logic. Handles Three.js 3D rendering, GLB model loading, muscle heatmapping, workout logging, state management, and UI interactions. Integrates with PHP APIs for data persistence.
- **style.css**: Global CSS styles for layout and responsive design.
- **lib/exercises.js**: Utility for fetching and caching exercises from `api/exercises_list.php`. Key functions: `getAllExercisesCached()`, `getExerciseById()`.
- **lib/muscleMap.js**: Defines muscle groups, token-based classification for 3D mesh names, and filtering logic (e.g., ignoring micro-muscles or non-gym-relevant parts).
- **lib/recovery.js**: Handles muscle state simulation, including load decay over time, stimulus application, heat computation, and neglect detection.
- **lib/recs.js**: Generates workout recommendations based on muscle state (e.g., warnings for overtraining or nudges for neglected muscles).
- **lib/storage.js**: Unused remnant for localStorage-based state; app uses server APIs instead (safe to ignore or remove).
- **api/db.php**: Database connection setup using PDO with MySQL. Defines constants like `GLOBAL_USER_ID` (hardcoded to 0 for shared DB).
- **api/exercises_list.php**: GET endpoint for fetching active exercises.
- **api/get_exercises.php**: GET endpoint for fetching custom exercises from `exercises_custom` table.
- **api/get_logs.php**: GET endpoint for retrieving recent workout logs.
- **api/get_muscle_state.php**: GET endpoint for fetching muscle state.
- **api/log_workout.php**: POST endpoint for logging workouts.
- **api/state_reset.php**: POST endpoint for resetting user data.
- **api/add_exercises.php**: POST endpoint for adding/updating custom exercises.
- **ai_intake.html**: (Optional) Frontend for AI exercise intake UI (image upload, text description, Grok chat, approve proposals).
- **api/ai_intake_start.php**: (Optional) POST endpoint to start AI intake session.
- **api/ai_intake_step.php**: (Optional) POST endpoint for processing AI intake steps.
- **api/ai_intake_resolve.php**: (Optional) POST endpoint to resolve AI proposals.
- **api/ai_intake/db_intake.php**: (Optional) DB helpers for AI sessions.
- **api/ai_intake/helpers.php**: (Optional) Utility functions for AI intake.
- **api/ai_intake/images.php**: (Optional) Handles image uploads for AI intake.
- **api/ai_intake/mmj.php**: (Optional) Defines MMJ schema and processes AI output.
- **api/ai_intake/xai.php**: (Optional) Integration with xAI API.

## 2) Data Model (Tables + Key Fields)
Only tables and fields mentioned in notes are included.

- **muscle_state**: Tracks muscle load and timestamps per user.
  - Key fields: `user_id`, `muscle_group` (string), `load_value` (number 0-1), `last_trained_at` (int Unix timestamp), `last_ping_at` (int Unix timestamp).

- **workout_logs**: Stores workout entries.
  - Key fields: `user_id`, `workout_date` (string YYYY-MM-DD), `exercise_id` (string), `exercise_name` (string), `sets` (int), `reps` (int), `load_lbs` (number|null), `stimulus` (number).

- **exercises** or **exercises_custom**: Stores exercise definitions.
  - Key fields: `user_id`, `exercise_key` (string ID), `name` (string), `weights_json` (JSON object with muscle groups and weights 0-1).

- **ai_intake_sessions**: (Optional, for AI intake) Tracks AI sessions.
  - Key fields: (Uncertain; inferred as session ID, user_id, messages, history. Exact fields not specified in notes.)

## 3) API Endpoints
Endpoints include path, method, request JSON (if applicable), response JSON, and common errors.

- **api/exercises_list.php** (GET): Fetches active exercises.
  - Request: None (query params uncertain).
  - Response: `{ ok: boolean, exercises: array<{ id: string, name: string, w: { [groupId: string]: number (0-1) } }> }`.
  - Errors: JSON `{ ok: false, error: string }` (e.g., DB connection failure).

- **api/get_exercises.php** (GET): Fetches custom exercises.
  - Request: None.
  - Response: Similar to exercises_list.php.
  - Errors: JSON `{ ok: false, error: string }`.

- **api/get_logs.php** (GET): Retrieves recent logs (up to 250).
  - Request: None.
  - Response: `{ ok: boolean, rows: array<{ id: int, workout_date: string, exercise_id: string, exercise_name: string, sets: int, reps: int, load_lbs: number|null, stimulus: number }> }`.
  - Errors: JSON `{ ok: false, error: string }`.

- **api/get_muscle_state.php** (GET): Fetches muscle state.
  - Request: None.
  - Response: `{ ok: boolean, rows: array<{ muscle_group: string, load_value: number (0-1), last_trained_at: int, last_ping_at: int }> }`.
  - Errors: JSON `{ ok: false, error: string }`.

- **api/log_workout.php** (POST): Logs a workout, updates muscle_state.
  - Request: `{ date: string, exercise_id: string, exercise_name: string, sets: int, reps: int, load_lbs: number|null, stimulus: number (0-1), muscles: { [groupId: string]: number (0-1) } }`.
  - Response: `{ ok: boolean }` (success) or `{ ok: false, error: string }`.
  - Errors: Validation failures (e.g., invalid stimulus), DB insert errors.

- **api/state_reset.php** (POST): Resets user data.
  - Request: None (or empty JSON).
  - Response: `{ ok: boolean }`.
  - Errors: JSON `{ ok: false, error: string }` (e.g., delete failure).

- **api/add_exercises.php** (POST): Adds/updates custom exercises.
  - Request: `{ id: string (snake_case, 2-64 chars), name: string (1-128 chars), w: { [groupId: string]: number (0-1) } }`.
  - Response: `{ ok: boolean }`.
  - Errors: Validation errors (e.g., invalid ID), DB insert errors.

- **api/ai_intake_start.php** (POST, optional): Starts AI session.
  - Request: (Uncertain; likely session init data).
  - Response: `{ ok: boolean, session_id: string }` (inferred).
  - Errors: JSON `{ ok: false, error: string }`.

- **api/ai_intake_step.php** (POST, optional): Processes AI step.
  - Request: User input + image data.
  - Response: Processed MMJ output.
  - Errors: xAI API failures, invalid input.

- **api/ai_intake_resolve.php** (POST, optional): Resolves proposals.
  - Request: Approval data.
  - Response: `{ ok: boolean }`.
  - Errors: Insertion failures.

## 4) Frontend Flow
- **Pages**: Main page (`index.html`) for core app; optional AI intake page (`ai_intake.html`).
- **JS Modules**: `main.js` orchestrates; imports from `lib/` (e.g., `exercises.js` for caching, `recovery.js` for state simulation, `recs.js` for recommendations, `muscleMap.js` for 3D mapping).
- **How Calls Happen**:
  - On load, `main.js` fetches exercises via `lib/exercises.js` → `api/exercises_list.php` to populate dropdowns.
  - Loads muscle state from `api/get_muscle_state.php` and logs from `api/get_logs.php`.
  - 3D rendering: Loads GLB models, classifies meshes with `lib/muscleMap.js`, applies heat from `lib/recovery.js`.
  - Logging: Form submission in `main.js` computes stimulus, posts to `api/log_workout.php`, updates local state and UI.
  - Recommendations: `lib/recs.js` analyzes state for warnings/nudges, displayed in panel.
  - Reset: Button triggers POST to `api/state_reset.php`.
  - AI Flow (optional): `ai_intake.html` starts session via `api/ai_intake_start.php`, processes steps with `api/ai_intake_step.php` (calls xAI), resolves with `api/ai_intake_resolve.php`.

## 5) AI Intake / MMJ Schema Explanation (If Present)
AI intake modules handle exercise proposals via xAI/Grok. They can be safely removed to restart AI development without breaking core app (manual exercise addition via `api/add_exercises.php` remains). Removable files: `ai_intake.html`, `api/ai_intake_start.php`, `api/ai_intake_step.php`, `api/ai_intake_resolve.php`, `api/ai_intake/db_intake.php`, `api/ai_intake/helpers.php`, `api/ai_intake/images.php`, `api/ai_intake/mmj.php`, `api/ai_intake/xai.php`.

- **Flow**: User uploads image/text in `ai_intake.html`, starts session, steps through xAI chats, approves proposals inserted into `exercises` table.
- **MMJ Schema** (from `api/ai_intake/mmj.php`): Structured AI response.
  - `{ mmj: "1", action: "PROPOSE_NEW"|"MATCH_EXISTING"|"QUESTION"|"ERROR", message: string, proposal?: { exercise_key: string, name: string, weights: {
