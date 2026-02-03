# MuscleMap Developer Manual

## Overview

MuscleMap is a web-based fitness tracking app with a 3D human body model (Three.js + Z-Anatomy GLB) for muscle heat maps. Users log workouts via `index.html` (live editing or past workout edits), view recovery heat (36-hour decay via `lib/heat_engine.js` and `lib/recovery.js`), calibrate per-muscle sensitivity (`api/muscle_sensitivity.php`), and add exercises via AI chat (`ai_chat.html` -> `api/ai_chat.php` -> xAI Grok). Per-exercise timer prefs stored in `api/exercise_prefs.php`. All endpoints require login via `api/auth/*.php` and use `api/db.php` for PDO + session.

```
High-level Architecture (ASCII):

[Browser: index.html / ai_chat.html / login.html]
          |
          v
[JS: main.js -> lib/*.js (heat_engine.js, renderer3d.js, workout_ui.js, etc.)]
          |
          v  (fetch /apiJson)
[PHP API: api/*.php (require db.php -> PDO MySQL)]
          |
          +-- DB: users, exercises, workouts, workout_sets, muscle_sensitivity, exercise_prefs
          |
          +-- xAI: api/ai_chat.php (grok-4-0709) -> proposals -> api/add_exercises.php
          |
          v
[3D Render: Three.js + body.glb (assets/models/)]
[Uploads: api/ai_upload.php -> /uploads/ai_tmp/u{uid}/{token}.ext (TTL 24h)]
```

## 1) Directory/Module Map

```
musclemap/
├── index.html          # Main app: 3D viewer + workout editor + history
├── ai_chat.html        # AI exercise builder (chat + image upload + 3D preview)
├── login.html          # Auth (login/register/logout)
├── style.css           # Global styles (mobile-first grid)
├── ai_chat.css         # AI chat specific (sidebar preview + chat bubbles)
├── main.js             # Entry: orchestrates renderer3d.js, heat_engine.js, workout_ui.js
├── lib/
│   ├── api.js          # apiJson() wrapper + endpoints consts
│   ├── exercises.js    # getAllExercisesCached() -> api/exercises_list.php
│   ├── heat_engine.js  # createHeatEngine(): logs -> muscle state (overall/workout modes)
│   ├── muscleMap.js    # classifyMeshName(): GLB mesh -> {kind: "gym", groups: []}
│   ├── recovery.js     # computeHeat(): load * sens + decay -> {heat, overdo}
│   ├── recs.js         # generateRecs(): neglected/overdo nudges
│   ├── renderer3d.js   # createRenderer3D(): Three.js + OrbitControls + raycast pick
│   ├── set_timers.js   # createSetTimerManager(): per-set rest timers (live-only)
│   ├── utils.js        # fmtElapsed(), escapeHtml(), parseSqlDateTime()
│   ├── workout_editor.js # createWorkoutEditor(): render sets + wire interactions
│   ├── workout_history.js # createWorkoutHistory(): paginated list_workouts.php
│   └── workout_ui.js   # createWorkoutUI(): orchestrates editor/history/timers/prefs
├── api/
│   ├── db.php          # PDO bootstrap + session + json_ok()/json_err() + require_user_id()
│   ├── auth/           # login.php, logout.php, register.php (users table)
│   ├── workout/        # _lib.php + CRUD: status.php, start.php, end.php, add_set.php, etc.
│   ├── add_exercises.php # INSERT/UPDATE exercises (user_id, exercise_key, weights_json)
│   ├── ai_chat.php     # xAI Grok chat: history + images -> proposals (MMJ schema)
│   ├── ai_upload.php   # Image upload: /uploads/ai_tmp/u{uid}/{token}.ext (TTL 24h)
│   ├── exercises_list.php # SELECT exercises (user_id, is_active=1)
│   ├── muscle_sensitivity.php # GET/POST {map: {group_id: sens}}
│   └── exercise_prefs.php # GET/POST per-ex {timer_enabled, timer_secs}
└── assets/models/      # body.glb, body.draco.glb (Z-Anatomy)
```

**Hotspots** (from token_audit.php): `main.js` (orchestrator), `lib/workout_ui.js` (timers/editor), `ai_chat.js` (3D + chat), `api/ai_chat.php` (xAI + schema), `api/db.php` (auth/DB bootstrap).

## 2) Data Model (tables + key fields)

Inferred from code/DB queries (no full dump provided).

- **users**: `id` (PK int), `email` (unique lowercase), `password_hash`
- **exercises**: `user_id` (FK), `exercise_key` (unique w/ user_id, snake_case), `name` (≤128), `weights_json` ({"group_id":0.0-1.0}), `source` ("user"/"ai"), `is_active` (tinyint), `updated_at` (timestamp)
- **workouts**: `id` (PK), `user_id` (FK), `started_at`/`ended_at` (datetime), `auto_closed` (tinyint), `created_at`/`updated_at`
- **workout_sets**: `id` (PK), `workout_id` (FK), `user_id` (FK), `exercise_id` (str), `exercise_name` (str), `reps` (int 1-1000), `load_lbs` (float|null), `stimulus` (float 0-5), `completed` (tinyint 0/1), `muscles_json` ({"group_id":float}), `created_at`/`updated_at`
- **muscle_sensitivity**: `user_id` (FK), `group_id` (snake_case), `sensitivity` (float 0.05-1.5), `updated_at`
- **exercise_prefs**: `user_id` (FK), `exercise_key` (unique w/ user_id), `prefs_json` ({"timer_enabled":bool,"timer_secs":int 0-3600}), `updated_at`

Invariants: All per-user (user_id FK). exercises UNIQUE(user_id,exercise_key). workouts auto-close after 5h (`api/workout/_lib.php::autoclose_if_needed()`). workout_sets ordered by id/created_at.

## 3) API Endpoints

All return `{ok:bool, error?:str}`. Require login (`require_user_id()` -> 401). Use `apiJson()` in JS (auto-redirects 401 to login.html).

| Path | Method | Request JSON | Response JSON | Errors |
|------|--------|--------------|---------------|--------|
| `/api/auth/login.php` | POST | `{email:str, password:str}` | `{ok:true, user_id:int}` | 400 bad_email/bad_password, 401 invalid_credentials |
| `/api/auth/register.php` | POST | `{email:str, password:str (≥6)}` | `{ok:true, user_id:int}` | 400 bad_email/bad_password, 409 email_taken, 500 hash_fail |
| `/api/auth/logout.php` | POST | - | `{ok:true}` | - |
| `/api/workout/status.php` | GET | - | `{ok:true, active:{id,started_at,ended_at,auto_closed,summary}}` or `{active:null}` | 401 unauthorized |
| `/api/workout/start.php` | POST/GET | - | `{ok:true, workout:{id,started_at,ended_at,summary}}` | 401 |
| `/api/workout/end.php` | POST/GET | - | `{ok:true, ended:bool, workout_id?:int, ended_at?:str, summary?:obj}` | 401 |
| `/api/workout/get_current.php` | GET | - | `{ok:true, active?:obj, sets:[]}` | 401 |
| `/api/workout/get_workout.php?id=N` | GET/POST | `{id:int}` (POST) | `{ok:true, workout:obj, sets:[]}` | 400 missing_id, 404 not_found, 401 |
| `/api/workout/list_workouts.php?page=N&per=M` | GET | - | `{ok:true, page:int, pages:int, per:int, total:int, workouts:[]}` | 401 |
| `/api/workout/add_set.php` | POST | `{exercise_id:str, exercise_name:str, reps:int, load_lbs?:float|null, stimulus:float, completed:int(0/1), muscles?:obj}` | `{ok:true, set:obj, summary:obj}` | 409 no_active_workout, 400 validation, 401 |
| `/api/workout/update_set.php` | POST | `{set_id:int, reps?:int, load_lbs?:float|null, stimulus?:float, completed?:int(0/1), muscles?:obj}` | `{ok:true, updated:bool, summary?:obj}` | 400 bad_set_id/no_fields, 404 not_found, 401 |
| `/api/workout/delete_set.php` | POST | `{set_id:int}` | `{ok:true, deleted:bool, summary:obj}` | 404 not_found, 401 |
| `/api/exercises_list.php` | GET | - | `{ok:true, exercises:[{id:str, name:str, w:obj}]}` | 401 |
| `/api/muscle_sensitivity.php` | GET/POST | `{map?:obj}` (POST) or `{group_id:str, sensitivity:float}` | `{ok:true, map:obj}` (GET), `{ok:true, saved:int}` (POST) | 400 missing_group_id_or_map, 405 method_not_allowed, 401 |
| `/api/exercise_prefs.php` | GET/POST | `{map?:obj}` or `{exercise_key:str, prefs:obj}` | `{ok:true, map:obj}` (GET), `{ok:true, saved:int}` (POST) | 400 missing_or_bad_exercise_key/missing_prefs_object, 405 method_not_allowed, 401 |
| `/api/ai_upload.php` | POST | Multipart `image` file (≤4.5MB jpg/png/webp) | `{ok:true, token:str(32hex), mime:str, url:str}` | 400 missing_image/bad_upload_shape/upload_error/bad_size/bad_image_type/too_large, 405 method_not_allowed, 401, 413 too_large, 415 bad_image_type, 500 mkdir_fail/write_fail |
| `/api/ai_chat.php` | POST | `{history:[], text:str, image_tokens:[str(32hex)]}` | `{ok:true, assistant:{role:str, text:str, reply:obj, raw_json:obj}, history:[]}` | 400 bad_json/missing_payload/missing_input, 401, 500 db_error/json_fail/missing_api_key/xai_* |
| `/api/add_exercises.php` | POST | `{id:str(snake_case), name:str(≤128), w:obj, source?:"ai"}` | `{ok:true}` | 400 invalid_json/bad_id/bad_name/bad_weights/empty_weights, 500 json_fail/server_error, 401 |

## 4) Frontend Flow (pages, JS modules, how calls happen)

- **index.html** (`main.js` entry): Loads exercises (`lib/exercises.js::getAllExercisesCached()` -> `api/exercises_list.php`), sensitivity (`api/muscle_sensitivity.php`), sensitivity (`api/exercise_prefs.php`). Wires `createRenderer3D` (`lib/renderer3d.js`), `createHeatEngine` (`lib/heat_engine.js`), `createWorkoutUI` (`lib/workout_ui.js`). Loop: `animate()` ticks `workoutUI.tickTimer()`, `heat.tick()` every 2s, polls `api/workout/status.php` every 15s. Heat modes: overall (`heat.rebuildNow()` paginates `api/workout/list_workouts.php` + `get_workout.php`), workout (`heat.setWorkoutSets(completed sets)` from editor).
- **ai_chat.html** (`ai_chat.js`): Chat UI + image upload (`api/ai_upload.php` -> TTL files), sends to `api/ai_chat.php` (xAI Grok + proposals), 3D preview (`loadPreviewGLB()` + `applyPreviewWeights()`), accept -> `api/add_exercises.php` + redirect w/ `?new_ex=KEY` (preselects in `index.html` if active workout).
- **login.html**: `api/auth/login.php`/`register.php`/`logout.php`.
- **JS modules**: `main.js` orchestrates; `lib/workout_ui.js` owns workout CRUD/editor/history/timers (`lib/set_timers.js`); `lib/workout_editor.js` renders sets; `lib/workout_history.js` paginates history; `lib/renderer3d.js` raycasts picks + paints heat; `lib/heat_engine.js` computes muscle state; `lib/recovery.js::computeHeat()` + `lib/recs.js`; `lib/muscleMap.js::classifyMeshName()` maps GLB meshes.
- Flow: UI events -> `apiJson()` (fetch + JSON + 401 redirect) -> PHP (`db.php::require_user_id()`) -> PDO/DB or xAI (`api/ai_chat.php`) -> JSON response -> state update -> re-render/paint (`applyHeatToAllMeshes()`).

## 5) AI Intake / MMJ schema explanation (if present)

Present in `api/ai_chat.php`: xAI Grok (`grok-4-0709`) processes `{history:[], text:str, image_tokens:[]}` (uploads via `api/ai_upload.php`). Loads user exercises (`exercises` table). System prompt enforces JSON reply schema:

```
{
  "type": "error"|"question"|"exists"|"propose_add"|"propose_add_many",
  "text": "string",
  "choices": ["string", ...],  // question
  "id": "exercise_key", "name": "string",  // exists
  "proposal": { "exercise_key": snake_case, "name": str, "weights": {group_id:float(0-1)}, "confidence":0-1 },
  "proposals": [proposal... ]  // ≤6
}
```

Server normalizes/enforces: snake_case keys from `muscleMap.js GROUPS`, clamps weights 0-1/≤6 groups, exact-match check vs DB (`exactMatchExercise()`), allowed groups hardcoded (`abs_upper` etc.). Proposals -> `ai_chat.html` cards w/ preview/add/reject. Add via `api/add_exercises.php` (INSERT/UPDATE `exercises` w/ `weights_json`).

## 6) How to Extend

- **New exercise**: AI chat (`ai_chat.html`) -> accept proposal -> `api/add_exercises.php` (user-owned, `is_active=1`). Manual: POST `{id:"snake_case", name:"Ex Name", w:{"chest":0.8,...}, source:"user"}`. List via `lib/exercises.js::getAllExercisesCached()`.
- **New muscle group**: `lib/muscleMap.js GROUPS[]` (id,label,tokens). Update `classifyMeshName()` matches. Sensitivity: `api/muscle_sensitivity.php POST {map:{"new_group":1.2}}`. Allowed in AI: `api/ai_chat.php $allowedIds[]`.
- **New endpoint**: `api/*.php` (require `db.php`), `require_user_id()`, `json_ok()`/`json_err()`. Add to `lib/api.js API`. Use `apiJson()` in JS.
- **New heat mode**: `lib/heat_engine.js::setMode()`, update `main.js` buttons/`rebuildHeatAndPaint()`.
- **New GLB mesh**: `lib/muscleMap.js::classifyMeshName()` -> `{kind:"gym", groups:["chest"]}` for paint/pick.

## 7) Troubleshooting

- **401 unauthorized**: Session expired (`api/db.php::require_user_id()`). Check `login.html`, clear cookies, `/logs/errors-*.log`.
- **Non-JSON response**: `apiJson()` throws w/ snippet. Check PHP `json_ok()`/`json_err()`, `/logs/errors.log` (daily rotation via `db.php`).
- **Model load fail**: `assets/models/body.glb` missing (`renderer3d.js::loadGLBWithFallback()`). Download Z-Anatomy.
- **AI upload fail**: `/uploads/ai_tmp/u{uid}/` perms (755), TTL cleanup (`ai_upload.php`). Max 4.5MB/image, ≤6.
- **Heat stale**: Cache TTL 2min (`heat_engine.js`), invalidate `invalidateOverallCache()`. Poll `status.php`.
- **Timers wrong**: Prefs `api/exercise_prefs.php`, live-only (`lib/set_timers.js`). Check `completed=1`.
- **DB errors**: PDO in `db.php` (`musclemap@localhost`), check queries/keys (`exercises UNIQUE(user_id,exercise_key)`).

## 8) Q&A

_Questions/answers appended over time._

## Q&A

_Questions and answers are appended here over time._

### Q: I want to introduce a memory system, when a suer starts a new workout and adds a new exercise, the app looks at the last workout that had that workout and loads that in wiht all the checkmarks set to 0, the user of course cna change it but basically we pre fill in everything including reps weights # of sets and timer waiting between them, how would we implement this tell em what files are needed to chnage in a python list FILES = []
```
**Implementation Plan:**

1. **New PHP endpoint** (`api/workout/get_last_sets_for_exercise.php`): 
   - `require __DIR__ . "/_lib.php";`
   - `require_user_id();`
   - GET param `exercise_id` (str, required).
   - Query: most recent workout (ORDER BY started_at DESC LIMIT 1) that has `workout_sets` with matching `exercise_id` AND `user_id`.
   - For that workout, SELECT sets (reps, load_lbs, stimulus? but recompute in JS, created_at etc.) ORDER BY id ASC LIMIT 20.
   - Return `{ok:true, sets:[]}` normalized like get_workout.php.
   - Edge: if none, `{ok:true, sets:[]}`.

2. **lib/api.js**: Add `API.LAST_SETS_FOR_EX = "./api/workout/get_last_sets_for_exercise.php";`

3. **lib/workout_ui.js** (`addExerciseAsOneSet`):
   - Fetch ex = await getExerciseById(exId)
   - `const lastSetsData = await apiJson(`${API.LAST_SETS_FOR_EX}?exercise_id=${encodeURIComponent(ex.id)}`);`
   - `const lastSets = lastSetsData.sets || [];`
   - For each lastSet in lastSets.slice(0,20):
     - reps = lastSet.reps || 10
     - load_lbs = lastSet.load_lbs ?? null
     - stim = computeStimulusSingleSet(reps, load_lbs)
     - muscles = ex.w (exercise weights)
     - POST to WORKOUT_ADD_SET: {exercise_id:ex.id, exercise_name:ex.name, reps, load_lbs, stimulus:stim, completed:0, muscles}
   - If no lastSets, fallback to current single default set.
   - After all adds: `await loadCurrentWorkoutSets(); await refreshHistory();`

4. **lib/workout_editor.js**: No change (handles rendering new sets fine).

5. **Timers**: No change needed. New sets added with `completed=0`, so timers idle until user checks. Per-ex prefs already apply on check.

6. **Edge cases**:
   - No prior workouts/sets: add single default.
   - >20 prior sets: cap at 20.
   - Past workout auto-closed: fine, still usable.
   - Stimulus: recompute fresh (load/reps may change).
   - Permissions: endpoint uses `require_user_id()`.

**Benefits**: Zero UI change. Works live-only. Fast (1 DB query + N adds).

**Test**: Manually add ex to workout, verify sets pre-filled from last.

**Future**: Store `default_sets_json` in `exercise_prefs` for manual override.

FILES = [
    "api/workout/get_last_sets_for_exercise.php",  # NEW endpoint
    "lib/api.js",                                  # Add API.LAST_SETS_FOR_EX const
    "lib/workout_ui.js"                            # Update addExerciseAsOneSet()
]
```

### Q: I want to introduce a memory system, when a suer starts a new workout and adds a new exercise, the app looks at the last workout that had that workout and loads that in wiht all the checkmarks set to 0, the user of course cna change it but basically we pre fill in everything including reps weights # of sets and timer waiting between them, how would we implement this tell em what files are needed to chnage in a python list FILES = []
```
**Implementation Plan:**

1. **New PHP endpoint** (`api/workout/get_last_sets_for_exercise.php`): 
   - `require __DIR__ . "/_lib.php";`
   - `require_user_id();`
   - GET param `exercise_id` (str, required).
   - Query: most recent workout (ORDER BY started_at DESC LIMIT 1) that has `workout_sets` with matching `exercise_id` AND `user_id`.
   - For that workout, SELECT sets (reps, load_lbs, stimulus? but recompute in JS, created_at etc.) ORDER BY id ASC LIMIT 20.
   - Return `{ok:true, sets:[]}` normalized like get_workout.php.
   - Edge: if none, `{ok:true, sets:[]}`.

2. **lib/api.js**: Add `API.LAST_SETS_FOR_EX = "./api/workout/get_last_sets_for_exercise.php";`

3. **lib/workout_ui.js** (`addExerciseAsOneSet`):
   - Fetch ex = await getExerciseById(exId)
   - `const lastSetsData = await apiJson(`${API.LAST_SETS_FOR_EX}?exercise_id=${encodeURIComponent(ex.id)}`);`
   - `const lastSets = lastSetsData.sets || [];`
   - For each lastSet in lastSets.slice(0,20):
     - reps = lastSet.reps || 10
     - load_lbs = lastSet.load_lbs ?? null
     - stim = computeStimulusSingleSet(reps, load_lbs)
     - muscles = ex.w (exercise weights)
     - POST to WORKOUT_ADD_SET: {exercise_id:ex.id, exercise_name:ex.name, reps, load_lbs, stimulus:stim, completed:0, muscles}
   - If no lastSets, fallback to current single default set.
   - After all adds: `await loadCurrentWorkoutSets(); await refreshHistory();`

4. **Timers**: No change needed. New sets added with `completed=0`, so timers idle until user checks. Per-ex prefs already apply on check.

5. **Edge cases**:
   - No prior workouts/sets: add single default.
   - >20 prior sets: cap at 20.
   - Past workout auto-closed: fine, still usable.
   - Stimulus: recompute fresh (load/reps may change).
   - Permissions: endpoint uses `require_user_id()`.

**Benefits**: Zero UI change. Works live-only. Fast (1 DB query + N adds).

**Test**: Manually add ex to workout, verify sets pre-filled from last.

**Future**: Store `default_sets_json` in `exercise_prefs` for manual override.

FILES = [
    "api/workout/get_last_sets_for_exercise.php",  # NEW endpoint
    "lib/api.js",                                  # Add API.LAST_SETS_FOR_EX const
    "lib/workout_ui.js",                           # Update addExerciseAsOneSet()
    "api/workout/_lib.php",                        # DB helpers (user_id, get_active_workout)
    "api/workout/add_set.php"                      # POST add_set.php (for set format/fields)
]
```
