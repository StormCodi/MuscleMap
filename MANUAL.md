# MuscleMap Developer Manual

## Overview

MuscleMap is a web-based fitness tracking application featuring 3D muscle visualization using Three.js and Z-Anatomy GLB models, workout logging with stimulus tracking, per-muscle sensitivity adjustments, and an AI-powered exercise proposal system via xAI Grok. Users log workouts, view heat maps of muscle load/recovery, manage exercises, and use AI chat (ai_chat.html) to propose/add new exercises from text or images. Authentication is account-based (email/password). Data is per-user in MySQL.

```
High-Level Architecture (ASCII)

[Browser]                  [PHP API (/api/)]              [MySQL DB]          [xAI Grok]
  |                            |                               |                    |
  | index.html                 | db.php (PDO + session)        | users              |
  | ai_chat.html               | auth/*.php                    | exercises          |<-- AI proposals
  | login.html                 | workout/*.php                 | workouts           |     added here
  |                            | ai_*.php                      | workout_sets       |
  v                            | exercises_list.php            | muscle_sensitivity |
[JS Modules]  ------------>    v                               v                    ^
main.js, lib/*.js       POST/GET JSON   require_user_id() --> queries (user_id)     |
- renderer3d.js (3D)    credentials:    INSERT/SELECT/UPDATE                        |
- heat_engine.js (heat) same-origin     ON DUPLICATE KEY                            |
- workout_ui.js         cache: no-store transactions (workouts)                     |
- ai_chat.js (AI chat)                                              autoclosing workouts
```

## 1) Directory/Module Map

- **Root pages**:
  - `index.html`: Main 3D viewer + workout logger + history. Loads `main.js`.
  - `ai_chat.html`: AI chat for exercise proposals. Loads `ai_chat.js`.
  - `login.html`: Auth form (login/register). Inline JS calls auth endpoints.

- **CSS**:
  - `style.css`: Core styles (dark theme, panels, buttons).
  - `ai_chat.css`: AI chat-specific (chat bubbles, 3D preview, composer).

- **JS Modules** (`lib/` + pages):
  - `main.js`: Orchestrates index.html (heat engine, renderer3D, workoutUI, recs, sensitivity).
  - `lib/api.js`: `apiJson()` wrapper for all fetch calls. API constants.
  - `lib/exercises.js`: Caches exercises from `api/exercises_list.php`.
  - `lib/heat_engine.js`: Computes muscle heat from logs (`rebuildNow()`, `tick()`). Modes: "overall"/"workout".
  - `lib/muscleMap.js`: `classifyMeshName(name)` maps GLB meshes to groups (e.g., "triceps").
  - `lib/recovery.js`: `computeHeat()`, `applyStimulus()`, decay logic.
  - `lib/recs.js`: `generateRecs()` for recommendations.
  - `lib/renderer3d.js`: Three.js setup, GLB loader, raycasting picks, heat painting.
  - `lib/workout_ui.js`: Workout editor/history UI, CRUD via workout endpoints.
  - `ai_chat.js`: AI chat logic (history in localStorage, image upload, 3D preview).

- **PHP API** (`api/`):
  - `db.php`: PDO bootstrap, session, error logging (/logs/errors-*.log), `require_user_id()`.
  - `auth/login.php`, `auth/register.php`, `auth/logout.php`: User CRUD.
  - `exercises_list.php`/`get_exercises.php`: List user exercises.
  - `add_exercises.php`: Add/update exercise (key, name, weights_json).
  - `workout/*.php`: CRUD workouts/sets (start.php, add_set.php, etc.). Autoclose after 5h.
  - `ai_upload.php`: Image upload to /uploads/ai_tmp/u{uid}/{token}.ext (TTL 24h).
  - `ai_chat.php`: xAI Grok chat (history, images→base64), exact-match exercises, proposals.
  - `muscle_sensitivity.php`: GET/POST per-group sensitivity (0.05-1.5).
  - Legacy: `log_workout.php`, `get_logs.php`, `state_reset.php` (commented).

- **Assets**:
  - `assets/models/body.glb` (fallback: body.draco.glb): Z-Anatomy 3D model.

- **Other**:
  - `vendor/three/`: Three.js modules (importmap).

## 2) Data Model (tables + key fields)

Inferred from PHP code (no DB dump provided). All tables scoped to `user_id`. Uses JSON columns.

| Table              | Key Fields |
|--------------------|------------|
| `users`           | `id` (PK, int), `email` (unique, varchar), `password_hash` (varchar). |
| `exercises`       | `user_id` (int), `exercise_key` (string, unique w/ user_id), `name` (varchar<=128), `weights_json` (JSON {group_id: 0.0-1.0}), `source` ("user"/"ai"), `is_active` (bool), `updated_at` (timestamp). |
| `workouts`        | `id` (PK), `user_id` (int), `started_at`/`ended_at` (datetime, NULL=active), `auto_closed` (bool), `created_at`/`updated_at` (timestamp). |
| `workout_sets`    | `id` (PK, auto), `workout_id` (FK), `user_id` (int), `exercise_id`/`exercise_name` (string), `reps` (int 1-1000), `load_lbs` (float NULL), `stimulus` (float 0-5), `muscles_json` (JSON {group_id: float>0}), `created_at`/`updated_at` (timestamp). |
| `muscle_sensitivity` | `user_id` (int), `group_id` (string, unique w/ user_id), `sensitivity` (float 0.05-1.5), `updated_at` (timestamp). |
| `workout_logs`    | Legacy (mentioned in get_logs.php): `id`, `workout_date`, `exercise_id`/`exercise_name`, `sets`/`reps`, `load_lbs`, `stimulus`, `created_at`, `muscles_json`. Not found in active code. |

Invariants: `ON DUPLICATE KEY UPDATE` for exercises/sensitivity. Workouts autoclose after 5h (`WORKOUT_AUTOCLOSE_SECONDS`).

## 3) API Endpoints

All: `Content-Type: application/json`, require login (`require_user_id()` from `db.php`), `credentials: same-origin`, `cache: no-store`. Errors: `{"ok":false,"error":"msg"}` (HTTP 400/401/500).

| Path | Method | Request JSON | Response JSON | Errors/Notes |
|------|--------|--------------|---------------|--------------|
| `/api/auth/login.php` | POST | `{"email":"str","password":"str"}` | `{"ok":true,"user_id":int}` | `bad_email`, `bad_password`, `invalid_credentials` (401), `server_error` (500). |
| `/api/auth/register.php` | POST | `{"email":"str","password":"str"}` | `{"ok":true,"user_id":int}` | `email_taken` (409), etc. |
| `/api/auth/logout.php` | POST | - | `{"ok":true}` | Session cleared. |
| `/api/exercises_list.php` `/api/get_exercises.php` | GET | - | `{"ok":true,"exercises":[{"id":"str","name":"str","w":{group:0-1}}]}` | Per-user active exercises. |
| `/api/add_exercises.php` | POST | `{"id":"snake_case","name":"str","w":{group:0-1},"source":"ai/user"}` | `{"ok":true}` | `bad_id` (regex /^[a-z0-9_]{2,64}$/), `bad_name` (<=128), `empty_weights`. ON DUPLICATE KEY UPDATE. |
| `/api/workout/status.php` | GET | - | `{"ok":true,"active":{id,started_at,...}}` or `{"active":null}` | Active workout (autoclose check). |
| `/api/workout/start.php` | POST/GET | - | `{"ok":true,"workout":{id,started_at,...}}` | Returns existing if active. |
| `/api/workout/end.php` | POST/GET | - | `{"ok":true,"ended":true,"workout_id":int,...}` | Sets `ended_at`. |
| `/api/workout/get_current.php` | GET | - | `{"ok":true,"active":{...},"sets":[{id,exercise_id,reps,load_lbs,stimulus,muscles,...}]}` | Live workout sets. |
| `/api/workout/get_workout.php?id=N` | GET/POST `{"id":N}` | - | As above for specific workout. |
| `/api/workout/list_workouts.php?page=N&per=M` | GET | - | `{"ok":true,"page":int,"pages":int,"workouts":[{id,started_at,summary:{sets_count,exercises_count}}]}` | Paged history. |
| `/api/workout/add_set.php` | POST | `{"exercise_id":"str","exercise_name":"str","reps":int,"load_lbs":float?,"stimulus":float,"muscles":{group:float}}` | `{"ok":true,"set":{...},"summary":{...}}` | Appends to active workout. |
| `/api/workout/update_set.php` | POST | `{"set_id":int,"reps"?:int,"load_lbs"?:float,"stimulus"?:float,"muscles"?:{}}` | `{"ok":true,"updated":true,"summary":{...}}` | Partial update. |
| `/api/workout/delete_set.php` | POST | `{"set_id":int}` | `{"ok":true,"deleted":true,"summary":{...}}` | - |
| `/api/muscle_sensitivity.php` | GET | - | `{"ok":true,"map":{group_id:float}}` | Per-user sensitivities. |
| | POST | `{"map":{group:float}}` or `{"group_id":"str","sensitivity":float}` | `{"ok":true,"saved":int}` | Clamps 0.05-1.5. |
| `/api/ai_upload.php` | POST | Multipart `image` (jpg/png/webp <=4.5MB) | `{"ok":true,"token":"hex32","url":"./uploads/...","mime":"str"}` | Per-user /uploads/ai_tmp/u{uid}/{token}.ext (TTL 24h cleanup). |
| `/api/ai_chat.php` | POST | `{"history":[{role,text,images?}],text:"str",image_tokens:["hex32"]}` | `{"ok":true,"assistant":{"text":"str","reply":{type:"propose_add",proposal:{exercise_key,name,weights,confidence}},"raw_json":{}},"history":[...]}` | xAI Grok. Converts images→base64 (<=9MB total). Checks exact-match exercises. Reply types: error/question/exists/propose_add/propose_add_many. Allowed groups hardcoded. |
| `/api/log_workout.php` (legacy) | POST | `{"date":"YYYY-MM-DD","exercise_id","exercise_name","sets":int,"reps":int,"stimulus":float,"muscles":{}}` | `{"ok":true,"workout_id":int,"inserted_sets":int}` | Creates one-off workout. |

## 4) Frontend Flow

- **Auth**: `login.html` → POST auth endpoints → redirect `index.html` (session cookie).
- **Main (index.html)**:
  1. `main.js.boot()`: Load exercises (`exercises_list.php`), sensitivity (`muscle_sensitivity.php`), workoutUI.boot() (status/history), rebuildHeat (workout/list_workouts.php → sets).
  2. `renderer3d.loadGLBWithFallback()`: Loads body.glb, classifies meshes (`muscleMap.js`), raycast pick → `onSelect({mesh,name,groups})`.
  3. Heat loop (`animate()`): `heat.tick()` (decay) → `renderer3d.applyHeatToAllMeshes()` (emissive color by `computeHeat()`). Modes: overall (history) / workout (viewingSets).
  4. Workout: `workout_ui.js` → workout endpoints (start/add_set/etc.) → `onEditorSetsChanged(sets)` → `heat.setWorkoutSets()`.
  5. Sensitivity: Pick muscle → slider → POST `muscle_sensitivity.php` → `heat.setSensitivityMap()`.
- **AI Chat (ai_chat.html)**:
  1. Load history (localStorage `musclemap_ai_chat_v2`).
  2. Image pick → `ai_upload.php` (token/url) → attach.
  3. Send → `ai_chat.php` (history+images) → xAI → parse JSON reply (proposals) → render cards (accept→`add_exercises.php`).
  4. 3D preview: Loads body.glb, `applyPreviewWeights(proposal.weights)` (emissive by max group weight).

## 5) AI Intake / MMJ schema explanation

Present in `ai_chat.php` (MMJ=JSON schema for Grok).

- **System Prompt**: Lists user exercises JSON. Allowed groups: `abs_upper,abs_lower,...core`. Reply types: `error/question/exists/propose_add/propose_add_many`.
- **Schema** (exact keys):
  ```
  {
    "type": "propose_add",
    "text": "str",
    "proposal": {
      "exercise_key": "snake_case",
      "name": "str",
      "weights": {"group_id": 0.0-1.0},  // 1-6 groups, sorted
      "confidence": 0.0-1.0
    }
  }
  ```
  - Server normalizes: clamps weights (top 6), exact-match check (`normalizeName(name)` + weights), enforces allowed groups.
  - Images: tokens → base64 data: URLs (<=6, 9MB raw).
  - JS (`ai_chat.js`): Renders cards, preview weights on 3D, accept→`add_exercises.php`.

## 6) How to Extend

- **New exercise**: POST `add_exercises.php` {"id":"new_key","name":"Pushup","w":{"chest":0.8,"triceps":0.4},"source":"user"}. Refreshes via `bustExercisesCache()` in lib/exercises.js.
- **New muscle group**: Add to `lib/muscleMap.js` GROUPS array (id,label,tokens). Update `ai_chat.php` $allowedIds. Client classifies meshes automatically.
- **New endpoint**: Add PHP in `/api/` (require `db.php`), use `json_ok()`/`json_err()`. Export const in `lib/api.js`. Call via `apiJson()`.
- **New heat mode**: Extend `heat_engine.js` setMode(), add button in index.html + main.js setHeatMode().
- **New AI reply type**: Update `ai_chat.php` system prompt + normProposal(). Handle in `ai_chat.js` renderReplyCard().

## 7) Troubleshooting

| Issue | Where to Look |
|-------|---------------|
| 401 Unauthorized | Session expired (`db.php` require_user_id()). Check /logs/errors-*.log. Refresh login.html. |
| Model not loading | Console: GLB loader in renderer3d.js/loadGLBWithFallback(). Ensure assets/models/body.glb. |
| No heat | heat_engine.js rebuildNow() → workout/list_workouts.php. Check logs empty? Start workout. |
| AI proposals fail | ai_chat.php: xAI key (/etc/musclemap/xai_api_key), image budget (9MB), JSON parse. Console: raw_json. |
| Upload fail | ai_upload.php: /uploads/ai_tmp perms (0775), file size <=4.5MB. TTL cleanup. |
| DB errors | /logs/errors-YYYY-MM-DD.log (db.php handler). PDO exceptions. |
| JS cache stale | lib/exercises.js TTL=60s. Hard refresh (no-store). |
| Sensitivity not saving | muscle_sensitivity.php POST {map:{group:1.2}}. Clamps 0.05-1.5. |

## 8) Q&A

_Questions/answers appended over time._

