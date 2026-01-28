# MuscleMap Developer Manual

## Overview

MuscleMap is a web-based fitness tracking app with 3D muscle visualization, workout logging, exercise management, and an AI-powered exercise proposal system via xAI Grok. It features heat-based muscle recovery visualization, per-muscle sensitivity calibration, workout CRUD, and AI exercise addition from text/image prompts. Multi-user support is partially migrated (PHP sessions via `api/db.php:require_user_id()`; login/register/logout; per-user data isolation). Tech: Vanilla JS/ESM + Three.js, PHP 8 (PDO/MySQL), single DB `musclemap`. Uploads: per-user `/uploads/ai_tmp/u{user_id}/{token}.ext` (24h TTL).

```
High-Level Architecture (ASCII)

[Browser: index.html / ai_chat.html / login.html]
          |
          v
[JS: main.js / ai_chat.js / lib/*.js (renderer3d.js, heat_engine.js, workout_ui.js)]
          |
          | fetch() / FormData
          v
[PHP APIs: api/*.php (auth/*.php, workout/*.php, ai_chat.php, add_exercises.php)]
          |
          | PDO (user_id scoping via GLOBAL_USER_ID)
          v
[MySQL: musclemap (users, exercises, workouts, workout_sets, muscle_sensitivity)]
          ^
          | xAI Grok (ai_chat.php only)
          |
[Uploads: /uploads/ai_tmp/u{user_id}/ (AI images, 24h TTL)]
```

## 1) Directory/Module Map

```
.
├── index.html              # Main: 3D viewer + workout UI + history
├── ai_chat.html            # AI chat: text/image -> proposals + 3D preview
├── login.html              # Auth: login/register/logout (new multi-user)
├── ai_chat.css             # AI chat styles
├── style.css               # Core styles
├── main.js                 # Bootstrap: renderer3d, heat_engine, workout_ui
├── ai_chat.js              # AI: uploadOneImage(), sendToServer(), renderReplyCard()
├── lib/
│   ├── api.js              # apiJson() (401→login), API consts
│   ├── exercises.js        # getAllExercisesCached() (exercises_list.php)
│   ├── heat_engine.js      # rebuildMuscleFromLogs(), tick(), sensitivity
│   ├── muscleMap.js        # classifyMeshName() → {kind:"gym",groups:[]}
│   ├── recovery.js         # computeHeat(), applyStimulus() (sens-aware)
│   ├── recs.js             # generateRecs() from heat
│   ├── renderer3d.js       # Three.js: loadGLBWithFallback(), applyHeatToAllMeshes()
│   ├── storage.js          # localStorage (legacy)
│   └── workout_ui.js       # CRUD: renderWorkoutEditor(), boot()
├── api/
│   ├── db.php              # PDO, session_start(), require_user_id() → GLOBAL_USER_ID
│   ├── auth/               # NEW multi-user
│   │   ├── login.php       # POST {email,pass} → $_SESSION['user_id']
│   │   ├── logout.php      # $_SESSION=[], session_destroy()
│   │   └── register.php    # INSERT users → session
│   ├── exercises_list.php  # GET active exercises (user_id scoped)
│   ├── add_exercises.php   # POST upsert exercise (require_user_id())
│   ├── ai_chat.php         # POST {history,text,image_tokens} → xAI → normProposal()
│   ├── ai_upload.php       # POST image → /uploads/ai_tmp/u{uid}/{token}.ext
│   ├── get_exercises.php   # GET exercises (legacy; require_user_id() added)
│   ├── get_logs.php        # GET workout_logs (legacy; require_user_id())
│   ├── log_workout.php     # POST legacy log → workout_sets (user_id())
│   ├── muscle_sensitivity.php # GET/POST {map:{group:sens}} (require_user_id())
│   ├── state_reset.php     # POST DELETE (commented; needs auth)
│   └── workout/            # (all via _lib.php:require_user_id())
│       ├── _lib.php        # json_ok(), get_active_workout(), autoclose_if_needed()
│       ├── add_set.php
│       ├── delete_set.php
│       ├── end.php
│       ├── get_current.php
│       ├── get_workout.php
│       ├── list_workouts.php
│       ├── start.php
│       ├── status.php
│       └── update_set.php
├── assets/models/          # body.glb etc. (not provided)
├── uploads/ai_tmp/u{uid}/  # Per-user AI images (24h TTL)
└── vendor/three/           # Three.js
```

**Key modules**:
- `main.js`: Wires renderer/heat/workout_ui; sensitivity UI.
- `ai_chat.js`: Image upload (`uploadOneImage()`), chat (`sendToServer()`), preview (`applyPreviewWeights()`). Raw fetch (no 401 handling).
- `heat_engine.js`: `rebuildNow()` from workout_sets; sensitivity integration.
- `api/db.php`: `require_user_id()` enforces auth (401 on fail).

## 2) Data Model

Inferred from PHP queries/code (no DB dump). All scoped to `user_id` (GLOBAL_USER_ID post-auth). JSON via `CAST(? AS JSON)`.

### users (inferred from api/auth/*.php)
- `id` (int PK auto)
- `email` (varchar UNIQUE)
- `password_hash` (varchar)

### exercises
- `user_id` (int)
- `exercise_key` (varchar PK/UNIQUE w/ user_id): snake_case
- `name` (varchar)
- `weights_json` (JSON): `{"chest":0.85,"triceps":0.45}` (0-1, snake_case)
- `source` (varchar: "user"/"ai")
- `is_active` (tinyint=1)
- `updated_at` (timestamp)

### workouts
- `id` (int PK auto)
- `user_id` (int)
- `started_at`/`ended_at` (datetime NULL)
- `auto_closed` (tinyint)
- `created_at`/`updated_at` (timestamp)

### workout_sets
- `id` (int PK auto)
- `workout_id` (int FK)
- `user_id` (int)
- `exercise_id`/`exercise_name` (varchar)
- `reps` (int)
- `load_lbs` (float NULL)
- `stimulus` (float 0-5)
- `muscles_json` (JSON snapshot)
- `created_at`/`updated_at` (timestamp)

### muscle_sensitivity
- `user_id` (int)
- `group_id` (varchar PK/UNIQUE w/ user_id): snake_case
- `sensitivity` (float 0.05-1.5)
- `updated_at` (timestamp)

### workout_logs (legacy)
- Similar to workout_sets; `workout_date` (date)

**Invariants**: Single active workout/user (5h autoclose `_lib.php`). Weights 0-1 snake_case. Snapshot muscles_json.

## 3) API Endpoints

All `{ok:bool,error?:str}` JSON. `credentials:"same-origin"`. Auth: `require_user_id()` (401 unauthorized if missing).

| Path | Method | Request | Response | Errors/Notes |
|------|--------|---------|----------|--------------|
| `/api/auth/login.php` | POST | `{email:"...",password:"..."}` | `{ok:true,user_id:N}` | 401 invalid_credentials, 400 bad_email/password |
| `/api/auth/register.php` | POST | `{email:"...",password:"..."}` | `{ok:true,user_id:N}` | 409 email_taken, 400 bad_email/password |
| `/api/auth/logout.php` | POST | - | `{ok:true}` | Clears session |
| `/api/exercises_list.php` | GET | - | `{exercises:[{id,name,w:{group:0.8}}]}` | Active, user-scoped |
| `/api/add_exercises.php` | POST | `{id:"snake",name:"...",w:{chest:0.9},source?:"ai"}` | `{ok:true}` | Upsert, clamps/validates |
| `/api/ai_upload.php` | POST | FormData `image` (<4.5MB jpg/png/webp) | `{token:"hex32",url:"./uploads/ai_tmp/uN/..."}` | Per-user dir, 24h TTL |
| `/api/ai_chat.php` | POST | `{history:[{role,text}],text?,image_tokens:["hex32"]}` | `{assistant:{text,reply:{type:"propose_add",proposal:{...}},raw_json}}` | xAI, per-user exercises/images |
| `/api/muscle_sensitivity.php` | GET | - | `{map:{chest:1.15}}` | User-scoped |
| `/api/muscle_sensitivity.php` | POST | `{map:{chest:1.15}}` or `{group_id:"chest",sensitivity:1.15}` | `{saved:N}` | Clamp 0.05-1.5 |
| `/api/workout/start.php` | POST/GET | - | `{workout:{id,started_at,summary}}` | Idempotent, autoclose 5h |
| `/api/workout/status.php` | GET | - | `{active:{id,...}}` or `{active:null}` | Autoclose check |
| `/api/workout/get_current.php` | GET | - | `{active:...,sets:[{id,exercise_id,reps,...}]}` | Live sets |
| `/api/workout/add_set.php` | POST | `{exercise_id,reps,load_lbs?,stimulus,muscles:{group:0.8}}` | `{set:...,summary}` | To active workout |
| `/api/workout/update_set.php` | POST | `{set_id,reps?,load_lbs?,stimulus?,muscles?}` | `{updated:true,summary}` | Partial |
| `/api/workout/delete_set.php` | POST | `{set_id}` | `{deleted:true,summary}` | - |
| `/api/workout/end.php` | POST/GET | - | `{ended:bool,...}` | Sets ended_at |
| `/api/workout/get_workout.php?id=N` | GET | - | `{workout:...,sets:[...]}` | Past workout |
| `/api/workout/list_workouts.php?page=1&per=5` | GET | - | `{workouts:[{id,summary}],pages}` | Paged, newest first |
| `/api/get_logs.php?limit=N` | GET | - | `{rows:[workout_logs]}` | Legacy |
| `/api/log_workout.php` | POST | Legacy `{date,exercise_id,...}` | `{ok:true}` | Migrates to workout_sets |

**Errors**: `{ok:false,error:"msg"}` (400/401/500/413). Auth 401→login.html (api.js).

## 4) Frontend Flow

**Main (`index.html` + `main.js`)**:
1. `getAllExercisesCached()` → `<select id="exerciseSelect">`, `heat.setExerciseWeightsById()`.
2. `renderer3d.loadGLBWithFallback()` → `classifyMeshName()` → gymMeshes.
3. `workoutUI.boot()` → `refreshStatus()`/`loadCurrentWorkoutSets()`/`refreshHistory()`.
4. `heat.rebuildNow()` → workout/list/get → `rebuildMuscleFromLogs()` → `applyHeatToAllMeshes()`.
5. `animate()`: `heat.tick()` → repaint/recs/timer. Poll status 15s.
6. Workout: `start.php` → `add_set.php` → `loadCurrentWorkoutSets()` → `heat.setWorkoutSets()`.
7. Muscle select → `setSelectedPanel()` → sensitivity UI (`setSensUIValue()` from `heat.getSensitivityMap()`).

**AI chat (`ai_chat.html` + `ai_chat.js`)**:
1. localStorage history (`LS_KEY="musclemap_ai_chat_v2"`).
2. Images → `onPickImages()` → `ai_upload.php` → tokens/urls.
3. `composer.submit` → `sendToServer()` → `ai_chat.php` → reply card.
4. "propose_add" → `applyPreviewWeights(proposal.weights)` (emissive).
5. Accept → `acceptProposal()` → `add_exercises.php`.

**Login (`login.html`)**: POST login/register → session → redirect index/ai_chat.

**End-to-end AI**: UI img/text → `ai_upload.php` (u{uid}/) → `ai_chat.php` (exercises/xAI/norm) → card → `add_exercises.php` → DB.

## 5) AI Intake / MMJ schema explanation

**Flow** (`ai_chat.php`): `{history,text,image_tokens}` → per-user images (`/uploads/ai_tmp/u{uid}/{token}.*` → base64) → system prompt (user exercises + allowed groups) → xAI "grok-4-0709" (temp=0.2) → parse/normalize.

**MMJ Schema** (server-validated):
```json
{"type":"error|question|exists|propose_add|propose_add_many","text":"str","choices?":["str"],"id?":"ex_key","name?":"str","proposal?":{"exercise_key":"snake","name":"str","weights":{"abs_upper":0.75},"confidence":0.0-1.0},"proposals?":[...]}
```
- Groups (26 hardcoded `$allowedIds`): abs_upper,...core.
- `normalizeId()`: snake_case. `exactMatchExercise()`: name+weights.
- Fallbacks: bad→question, exists→"exists".

**JS** (`ai_chat.js:renderReplyCard()`): Accept/Preview/Reject. Preview: emissive by max weight.

## 6) How to Extend

**New exercise**:
1. AI chat → propose → Accept (`add_exercises.php`).
2. Manual POST `/api/add_exercises.php`.

**New muscle**:
1. `lib/muscleMap.js`: `GROUPS` + `classifyMeshName()`.
2. `api/ai_chat.php`: `$allowedIds`.
3. Sensitivity auto (`muscle_sensitivity.php`).

**New endpoint**:
1. `api/new.php`: `require "db.php"; require_user_id();` + `json_ok()/json_err()`.
2. `lib/api.js`: const + `apiJson()`.

**Multi-user**: Most migrated (`require_user_id()`). Remaining: `ai_chat.js` (raw fetch→apiJson), legacy `get_logs.php` etc.

**AI tweak**: Edit `$system` in `ai_chat.php`.

## 7) Troubleshooting

| Issue | Where to look |
|-------|---------------|
| 401 unauthorized | No session: login.html. Check `api/db.php:session_start()`. |
| 500 DB | `api/db.php` creds/PDO. `users` table missing? |
| No model | `assets/models/body.glb` fail `loadGLBWithFallback()`. |
| Heat blank | No workouts: `api/workout/list_workouts.php`. `classifyMeshName()` rejects. |
| AI bad_json | xAI key `/etc/musclemap/xai_api_key`. `ai_chat.php` parse. |
| Upload fail | `/uploads/ai_tmp/u{uid}/` 775 perms, <4.5MB (`ai_upload.php`). |
| Exercises missing | `exercises` empty/is_active=0. |
| Sens ignored | `heat.getSensitivityMap()` empty → `api/muscle_sensitivity.php`. |
| No active workout | 5h autoclose (`_lib.php`). |
| ai_chat.js 401 silent | Raw fetch; wrap `apiJson()`. localStorage per-user prefix. |
| Legacy logs | `get_logs.php`/`log_workout.php`: add `require_user_id()`. |

**Logs**: PHP error_log, JS console. xAI: `ai_chat.php` curl `$httpCode`.

## 8) Q&A

_Questions and answers are appended here over time._

## Q&A

_Questions and answers are appended here over time._

### Q: Many files already in one way or another have a user_id get system, so if we want to extend our system to containarize it into accounts we should be able to do so by changing db.php, every single ai exercise added is goign to be more, so how much more would need to change on top of adding a login system to implement that?

**Minimal viable multi-user extension** (building on existing `user_id` scoping in all tables like `exercises`, `workouts`, `workout_sets`, `muscle_sensitivity`):

1. **DB changes** (low effort):
   - Add `users` table: `id (PK auto), email (UNIQUE), password_hash, created_at`. (Not present in code/DB dump.)
   - All existing tables already filter `WHERE user_id = ?` (e.g., `api/exercises_list.php`, `api/workout/_lib.php:user_id()`), so data

### Q: I want all the errors from this file to be logged, like a log folder that isn't git commited and that all the errors are writte in, we have log files title like errors-1-28-2026.log, how do we get this going, where errors.log is the one for the current day
**Add error logging to `api/db.php`** (included by all APIs via `require`):

1. **Create logs dir** (run once):
   ```
   mkdir -p logs && chmod 775 logs
   ```
   Add to `.gitignore`:
   ```
   /logs/
   ```

2. **In `api/db.php`** (after PDO setup, before auth helpers):
   ```php
   // Daily error logging (all APIs via require "db.php")
   $logDir = __DIR__ . "/../logs";
   if (!is_dir($logDir)) mkdir($logDir, 0775, true);

   $today = date("m-d-Y");  // e.g. "01-28-2026"
   $logFile = "$logDir/errors-$today.log";
   $currentLog = "$logDir/errors.log";  // symlink to today

   // Rotate symlink
   if (is_file($currentLog)) unlink($currentLog);
   symlink(basename($logFile), $currentLog);

   // Log ALL errors/fatal/exceptions here (project-wide)
   ini_set("log_errors", 1);
   ini_set("error_log", $logFile);
   ini_set("display_errors", 0);  // JSON-only, no HTML spew

   // Fatal handler (catches unhandled)
   register_shutdown_function(function() use ($logFile) {
     $e = error_get_last();
     if ($e && in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
       error_log("FATAL: {$e['message']} in {$e['file']}:{$e['line']}");
     }
   });
   ```

3. **Enhance `json_err()` / `mm_json_err()`** (in `api/db.php` / `api/workout/_lib.php`):
   ```php
   function json_err(string $msg, int $code = 400, array $extra = []): void {
     error_log("API_ERR: $msg");  // logs to daily file
     // ... existing JSON output
   }
   ```

**Invariants/edges**:
- Per-user via `GLOBAL_USER_ID`? No—logs are global (add `user_id:{$uid}` to msg if needed).
- Rotation: Symlink auto-updates daily; old logs persist.
- JS errors: Use `window.onerror` in `main.js`/`ai_chat.js` → `fetch("/logs/js_errors", {method:"POST",body:JSON.stringify(err)})` + new `api/js_errors.php`.
- Test: `curl "http://your.site/api/workout/status.php"` (expect 401 logged as "unauthorized").

**Next inspect**: `error_log` perms (644 files, 775 dir); tail `-f logs/errors.log`. No DB logging (add `error_log("DB: " . $e->getMessage())` in try/catch). Not in provided files (grep `error_log` → none).
