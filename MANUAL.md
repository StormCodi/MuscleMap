# MuscleMap Developer Manual

## Overview

MuscleMap is a web-based fitness tracking app with 3D muscle visualization, workout logging, exercise management, and an AI-powered exercise proposal system. It uses Three.js for interactive 3D body models (Z-Anatomy GLB), a MySQL backend for user data (single-user mode via `GLOBAL_USER_ID=0`), and xAI Grok for AI chat intake. Key features: heat-based muscle recovery visualization, per-muscle sensitivity calibration, workout CRUD, and AI exercise addition via image/text prompts.

**Tech stack**: Vanilla JS/ESM + Three.js, PHP 8 (PDO/MySQL), no frameworks. Single-user (hardcoded `GLOBAL_USER_ID=0` in `api/db.php`).

```
High-Level Architecture (ASCII)

[Browser: index.html / ai_chat.html]
          |
          v
[JS: main.js / ai_chat.js + lib/*.js (Three.js renderer, heat_engine.js, workout_ui.js)]
          |
          | fetch() / FormData
          v
[PHP APIs: api/*.php (ai_chat.php, workout/*.php, add_exercises.php)]
          |
          | PDO queries
          v
[MySQL: musclemap DB (exercises, workouts, workout_sets, etc.)]
          ^
          | xAI Grok API (only ai_chat.php)
          |
[Uploads: /uploads/ai_tmp/ (temp images for AI)]
```

## 1) Directory/Module Map

```
.
├── index.html              # Main app: 3D viewer + workout UI + history
├── ai_chat.html            # AI chat page: text/image -> exercise proposals
├── ai_chat.css             # AI chat styles (sidebar preview, chat bubbles)
├── style.css               # Core styles (3D viewer, sidebar panels)
├── main.js                 # App bootstrap: renderer3d.js, heat_engine.js, workout_ui.js
├── ai_chat.js              # AI chat logic: image upload, chat history (localStorage), 3D preview
├── lib/
│   ├── api.js              # API constants + apiJson() wrapper
│   ├── exercises.js        # Cached /api/exercises_list.php fetch
│   ├── heat_engine.js      # Core: rebuildMuscleFromLogs(), tick(), sensitivity support
│   ├── muscleMap.js        # classifyMeshName(): mesh -> {kind: "gym/shell/ignore", groups:[]}
│   ├── recovery.js         # computeHeat(), applyStimulus(), tickDecay()
│   ├── recs.js             # generateRecs() from heat state
│   ├── renderer3d.js       # Three.js: loadGLBWithFallback(), applyHeatToAllMeshes()
│   ├── storage.js          # localStorage for heat state (legacy, not used)
│   └── workout_ui.js       # Workout CRUD UI: renderWorkoutEditor(), boot()
├── api/
│   ├── db.php              # PDO setup, GLOBAL_USER_ID=0
│   ├── exercises_list.php  # GET exercises (active)
│   ├── add_exercises.php   # POST upsert exercise (user/ai source)
│   ├── ai_chat.php         # POST {history,text,image_tokens} -> xAI -> normalized reply
│   ├── ai_upload.php       # POST image -> token/url in /uploads/ai_tmp/
│   ├── get_exercises.php   # GET exercises_custom (unused?)
│   ├── get_logs.php        # GET workout_logs (legacy?)
│   ├── log_workout.php     # POST legacy log (workout_date,exercise_id,etc.)
│   ├── muscle_sensitivity.php # GET/POST {map:{group_id:sens}} sensitivity
│   ├── state_reset.php     # POST DELETE workout_logs (commented out)
│   └── workout/            # Modern workout APIs (_lib.php helpers)
│       ├── _lib.php        # json_ok(), get_active_workout(), etc.
│       ├── add_set.php     # POST {exercise_id,reps,stimulus,muscles}
│       ├── delete_set.php  # POST {set_id}
│       ├── end.php         # POST end active workout
│       ├── get_current.php # GET active workout + sets
│       ├── get_workout.php # GET ?id=N workout + sets
│       ├── list_workouts.php # GET ?page=1&per=5 workouts
│       ├── start.php       # POST start workout (idempotent)
│       ├── status.php      # GET active workout summary
│       └── update_set.php  # POST {set_id,reps,load_lbs,...}
├── assets/models/          # body.glb / body.draco.glb (not provided)
├── uploads/ai_tmp/         # Temp AI images {token}.jpg/png/webp (TTL 24h)
└── vendor/three/           # Three.js + addons
```

**Key modules**:
- `main.js`: Wires renderer, heat engine, workout UI.
- `ai_chat.js`: Chat composer, image upload (`uploadOneImage()`), 3D preview (`applyPreviewWeights()`).
- `heat_engine.js`: `rebuildNow()`, `rebuildMuscleFromLogs()` (from workout_sets/logs).
- `api/ai_chat.php`: xAI call, normalizes proposals (`normProposal()`), exact match check.

## 2) Data Model

Inferred from PHP code/queries (no DB dump provided). All tables scoped to `user_id` (`GLOBAL_USER_ID=0`). JSON fields use `CAST(? AS JSON)`.

### exercises
- `user_id` (int, PK part): User ID (0).
- `exercise_key` (varchar, PK/UNIQUE w/ user_id): snake_case id (e.g. "bench_press").
- `name` (varchar): Display name.
- `weights_json` (JSON): `{ "chest": 0.85, "triceps": 0.45 }` (0-1 floats, snake_case keys).
- `source` (enum? "user"/"ai"): Added by.
- `is_active` (tinyint=1): Filtered in lists.
- `updated_at` (timestamp): ON DUPLICATE KEY UPDATE.

**Upsert**: `api/add_exercises.php` validates id/name/weights, clamps 0-1.

### workouts
- `id` (int PK auto).
- `user_id` (int).
- `started_at` (datetime).
- `ended_at` (datetime NULL).
- `auto_closed` (tinyint=0/1): 5h autoclose (`api/workout/_lib.php`).
- `created_at`, `updated_at` (timestamp).

### workout_sets
- `id` (int PK auto).
- `workout_id` (int FK).
- `user_id` (int).
- `exercise_id` (varchar).
- `exercise_name` (varchar snapshot).
- `reps` (int 1-1000).
- `load_lbs` (float NULL).
- `stimulus` (float 0-5).
- `muscles_json` (JSON): `{ "chest": 0.85 }` snapshot.
- `created_at`, `updated_at` (timestamp).

**Legacy**: `workout_logs` (similar fields, `workout_date` date, `sets` int).

### muscle_sensitivity
- `user_id` (int).
- `group_id` (varchar PK/UNIQUE w/ user_id): e.g. "chest".
- `sensitivity` (float 0.05-1.5).
- `updated_at` (timestamp).

**Allowed groups** (`api/ai_chat.php`): abs_upper,abs_lower,obliques_external,... (26 total).

**Invariants**: Weights clamped 0-1, snake_case keys. Muscles snapshot in sets/logs. Single active workout (autoclose 5h).

## 3) API Endpoints

All return `{ok:bool, error?:str}` JSON. `credentials:"same-origin"`. User=0.

| Path | Method | Request | Response | Errors/Notes |
|------|--------|---------|----------|--------------|
| `/api/exercises_list.php` | GET | - | `{exercises:[{id,name,w:{group:0.8}}]}` | Active exercises. Used by `exercises.js`. |
| `/api/add_exercises.php` | POST | `{id:"snake_case",name:"Pushups",w:{chest:0.9},source?:"ai"}` | `{ok:true}` | Upsert, validates regex/clamps. Called by `ai_chat.js:acceptProposal()`. |
| `/api/ai_upload.php` | POST | FormData `image` (jpg/png/webp <4.5MB) | `{token:"hex32",url:"./uploads/ai_tmp/..."}` | Temp store, 24h TTL cleanup. `ai_chat.js:onPickImages()`. |
| `/api/ai_chat.php` | POST | `{history:[{role,text}],text?,image_tokens:["hex32"]}` | `{assistant:{text,reply:{type:"propose_add",proposal:{exercise_key,name,weights,confidence}},raw_json}}` | xAI Grok, normalizes proposals/exists. History slice(-40). |
| `/api/muscle_sensitivity.php` | GET | - | `{map:{chest:1.15}}` | `main.js:loadSensitivityFromServer()`. |
| `/api/muscle_sensitivity.php` | POST | `{map:{chest:1.15}}` OR `{group_id:"chest",sensitivity:1.15}` | `{saved:N}` | Clamp 0.05-1.5, upsert. |
| `/api/workout/start.php` | POST/GET | - | `{workout:{id,started_at,summary:{sets_count,exercises_count,total_reps}}}` | Idempotent if active. 5h autoclose. |
| `/api/workout/status.php` | GET | - | `{active:{id,started_at,ended_at,auto_closed,summary}}` OR `{active:null}` | `workout_ui.js:refreshStatus()`. |
| `/api/workout/get_current.php` | GET | - | `{active:...,sets:[{id,exercise_id,reps,load_lbs,stimulus,muscles,...}]}` | Live workout sets. |
| `/api/workout/add_set.php` | POST | `{exercise_id,reps,load_lbs?,stimulus,muscles:{group:0.8}}` | `{set:{...},summary}` | Adds to active. `workout_ui.js:addExerciseAsOneSet()`. |
| `/api/workout/update_set.php` | POST | `{set_id,reps?,load_lbs?,stimulus?,muscles?}` | `{updated:true,summary}` | Partial update. |
| `/api/workout/delete_set.php` | POST | `{set_id}` | `{deleted:true,summary}` | - |
| `/api/workout/end.php` | POST/GET | - | `{ended:bool,workout_id,summary}` | Sets `ended_at`. |
| `/api/workout/get_workout.php?id=N` | GET | - | `{workout:{id,started_at,...},sets:[...]}` | Past workout. `workout_ui.js:viewWorkout()`. |
| `/api/workout/list_workouts.php?page=1&per=5` | GET | - | `{page,pages,per,total,workouts:[{id,started_at,summary}]}` | Paged history. |

**Errors**: `{ok:false,error:"msg"}` (400/500). Validation: missing keys, bad types, clamps.

## 4) Frontend Flow

**Main app (`index.html` + `main.js`)**:
1. Boot: `getAllExercisesCached()` -> populate `<select id="exerciseSelect">`, `heat.setExerciseWeightsById()`.
2. `renderer3d.loadGLBWithFallback()` -> classifyMeshName() on meshes -> gymMeshes[].
3. `workoutUI.boot()` -> refreshStatus() / loadCurrentWorkoutSets() / refreshHistory().
4. `heat.rebuildNow()` -> fetch workouts/sets -> rebuildMuscleFromLogs() -> `renderer3d.applyHeatToAllMeshes()`.
5. Loop (`animate()`): `heat.tick()` (decay) -> repaint / recs / timer.
6. Workout: Start -> add_set.php -> `loadCurrentWorkoutSets()` -> `heat.setWorkoutSets()` (workout mode).
7. Select muscle -> `setSelectedPanel()` -> sensitivity UI (`main.js:setSensUIValue()` from `heat.getSensitivityMap()`).

**AI chat (`ai_chat.html` + `ai_chat.js`)**:
1. Load history from localStorage (`LS_KEY="musclemap_ai_chat_v2"`).
2. Image pick -> `onPickImages()` -> ai_upload.php -> attachments[] "ready".
3. Send (`composer.submit`) -> `sendToServer({history,text,image_tokens})` -> ai_chat.php -> xAI -> reply card.
4. Reply: "propose_add" -> 3D preview (`applyPreviewWeights(proposal.weights)`).
5. Accept -> `acceptProposal()` -> add_exercises.php -> `bustExercisesCache()` (not called, manual refresh).

**End-to-end (AI add exercise)**: UI text/img -> ai_upload.php -> ai_chat.php (fetch exercises -> xAI w/ system prompt -> normProposal()) -> JS render card -> add_exercises.php -> DB.

## 5) AI Intake / MMJ schema explanation

**Flow** (`ai_chat.php`): POST history/text/image_tokens -> resolve images (/uploads/ai_tmp/{token}.ext -> data:base64) -> system prompt w/ exercises JSON + allowed groups -> xAI "grok-4-0709" (temp=0.2) -> parse JSON reply -> normalize/enforce.

**MMJ Schema** (exact, validated server-side):
```json
{
  "type": "error|question|exists|propose_add|propose_add_many",
  "text": "str",
  "choices"?: ["str"],  // question only
  "id"?: "ex_key", "name"?: "str",  // exists only
  "proposal"?: {       // propose_add only
    "exercise_key": "snake_case",
    "name": "str",
    "weights": {"abs_upper":0.75,...},  // allowed groups, 0-1
    "confidence": 0.0-1.0
  },
  "proposals"?: [proposal...]  // propose_add_many (≤6)
}
```
- **Allowed groups** (26): abs_upper,abs_lower,...core (hardcoded `$allowedIds`).
- **normalizeId()**: snake_case [a-z0-9_]{2,64}.
- **exactMatchExercise()**: name+weights exact (normalized).
- **Fallbacks**: Bad proposal -> question. Exists -> "exists". Multi -> independent accepts.

**JS rendering** (`ai_chat.js:renderReplyCard()`): Cards w/ Accept/Preview/Reject. Preview: `applyPreviewWeights()` (emissive color by max weight).

## 6) How to Extend

**New exercise**:
1. UI: ai_chat.html -> describe/img -> propose_add -> Accept (`add_exercises.php`).
2. Manual: POST `/api/add_exercises.php` `{id:"new_squat",name:"Goblet Squat",w:{quads:0.9,glutes:0.7}}`.
3. List refresh: `exercises.js:bustExercisesCache()`.

**New muscle group**:
1. `lib/muscleMap.js`: Add to `GROUPS` `{id:"new_group",label:"New",tokens:["muscle_name"]}`.
2. `api/ai_chat.php`: Add to `$allowedIds`.
3. 3D: Ensure `classifyMeshName()` matches -> "gym" w/ groups:["new_group"].
4. Sensitivity: Auto-handled (`muscle_sensitivity.php`).

**New endpoint**:
1. `api/new.php`: `require "db.php";` + `json_ok()/json_err()` from `_lib.php`.
2. JS: `lib/api.js` add const, `apiJson(url)`.
3. Validate: `require_keys()`, `intv()/floatv()` clamps.

**New workout field**: Add to `workout_sets` schema + `add_set.php`/`update_set.php` + `workout_ui.js` inputs.

**AI prompt tweak**: Edit `$system` in `ai_chat.php` (regen on deploy).

## 7) Troubleshooting

| Issue | Where to look |
|-------|---------------|
| "No model" | `assets/models/body.glb` missing/fail `loadGLBWithFallback()` (ai_chat.js/main.js). |
| Heat blank | `heat.rebuildNow()` fail (no workouts), check `api/workout/list_workouts.php`. `classifyMeshName()` rejects meshes. |
| AI "bad_json" | xAI key `/etc/musclemap/xai_api_key`, curl logs. Reply parse fail (strip `{}` in `ai_chat.php`). |
| Upload fail | `/uploads/ai_tmp/` perms (775), size<4.5MB, jpg/png/webp (`ai_upload.php`). |
| Exercises missing | `exercises` table empty, `is_active=1`. AI adds w/ `source:"ai"`. |
| Sensitivity ignored | `heat.getSensitivityMap()` empty -> `api/muscle_sensitivity.php` GET. Clamps 0.05-1.5. |
| Workout "no active" | Autoclose 5h (`_lib.php:autoclose_if_needed()`). `GLOBAL_USER_ID=0`. |
| DB errors | `api/db.php` creds. PDO exceptions -> 500 `{error:"server_error"}`. |
| CORS/cred | `credentials:"same-origin"`, same-origin only. |

**Logs**: PHP `error_log`, JS console. xAI: `api/ai_chat.php` curl `$httpCode/$rawResponse`.

## 8) Q&A

_Questions and answers are appended here over time._

## Q&A

_Questions and answers are appended here over time._

### Q: Many files already in one way or another have a user_id get system, so if we want to extend our system to containarize it into accounts we should be able to do so by changing db.php, every single ai exercise added is goign to be more, so how much more would need to change on top of adding a login system to implement that?

**Minimal viable multi-user extension** (building on existing `user_id` scoping in all tables like `exercises`, `workouts`, `workout_sets`, `muscle_sensitivity`):

1. **DB changes** (low effort):
   - Add `users` table: `id (PK auto), email (UNIQUE), password_hash, created_at`. (Not present in code/DB dump.)
   - All existing tables already filter `WHERE user_id = ?` (e.g., `api/exercises_list.php`, `api/workout/_lib.php:user_id()`), so data is isolated.

2. **Backend changes** (medium; ~5-10 files):
   - `api/db.php`: Replace `define("GLOBAL_USER_ID", 0);` with session check:
     ```php
     session_start();
     if (!isset($_SESSION['user_id'])) throw new Exception("unauth");
     define("GLOBAL_USER_ID", (int)$_SESSION['user_id']);
     ```
     - Add `api/auth.php` endpoints: `login.php` (POST `{email,password}` → set `$_SESSION['user_id']`), `register.php`, `logout.php`.
   - `api/workout/_lib.php`: `user_id()` already uses `GLOBAL_USER_ID`; no change.
   - `api/ai_upload.php`: Per-user uploads → `/uploads/ai_tmp/{user_id}/{token}.ext` (update paths in `ai_chat.php` image resolution).
   - `api/ai_chat.php`: Exercises fetched per-user (`WHERE user_id = :uid`); AI proposals already check per-user exact matches.
   - Validate auth in all `api/*.php` (e.g., `if (!GLOBAL_USER_ID) bad("unauth", 401);`).
   - Error: `{ok:false, error:"unauthorized"}` (new code 401).

3. **Frontend changes** (high; new pages + guards):
   - New `login.html` + `login.js`: POST to `/api/login.php`, store `session` cookie (PHP `session_start()` handles).
   - Protect `index.html`/`ai_chat.html`: Check `fetch("/api/workout/status.php")` → if 401, redirect to login.
   - `main.js`/`ai_chat.js`: No user_id in payloads (PHP sessions); add logout btn → `fetch("/api/logout.php")`.
   - `localStorage`: Prefix keys (e.g., `musclemap_ai_chat_v2_{user_id}`) or clear on logout.
   - No change to Three.js/heat (per-session data).

4. **AI exercises**: Already per-user (`add_exercises.php` upserts w/ `user_id`); each account gets own list (`exercises_list.php` filters). No sharing.

5. **Invariants/edges preserved**:
   - Single active workout per-user (autoclose in `_lib.php`).
   - Sensitivities/exercises isolated.
   - Validation/clamps unchanged.

**Total new code**: ~200-400 LOC (auth endpoints + login page). Test: Login → add AI exercise → logout → login other → no crossover.

**Next inspect**: Add `users` table schema (missing); prototype `api/login.php` using `password_verify()`. No files block multi-user (all query `user_id`).

### Q: do any of our files instead of pulling the variable from db.php just define it as 0? or is anythign built assumign that it is 0 or just ignores it

No files redefine `GLOBAL_USER_ID=0` themselves. All DB-interacting APIs `require`/`require_once` `api/db.php` (which defines it), then use `GLOBAL_USER_ID` directly in PDO queries (e.g., `api/add_exercises.php`, `api/exercises_list.php`, `api/ai_chat.php`, `api/log_workout.php`, `api/get_logs.php`).

Two files add defensive fallbacks if undefined:
- `api/muscle_sensitivity.php`: `$USER_ID = defined("GLOBAL_USER_ID") ? (int)GLOBAL_USER_ID : 0;`
- `api/workout/_lib.php`: `function user_id(): int { return defined("GLOBAL_USER_ID") ? (int)GLOBAL_USER_ID : 0; }` (used by all `api/workout/*.php`).

No code assumes/ignores it—queries always filter `WHERE user_id = ?` with `GLOBAL_USER_ID` (or fallback 0). `api/ai_upload.php` has no DB/user_id.

**Next inspect**: Search codebase for `user_id`/`GLOBAL_USER_ID` (grep); test undefine in `db.php` → all fallback to 0 (single-user safe).
