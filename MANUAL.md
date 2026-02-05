# MuscleMap Developer Manual

## Overview

MuscleMap is a web-based fitness app featuring a 3D body model (Three.js + Z-Anatomy GLB) for visualizing muscle heat maps based on workout logs. Core features include live workout logging/editing in `index.html` (via `lib/workout_ui.js`), recovery heat visualization (36h decay in `lib/heat_engine.js`/`lib/recovery.js`), per-muscle sensitivity adjustments (`api/muscle_sensitivity.php`), per-exercise timer preferences (`api/exercise_prefs.php`), AI-powered exercise suggestions (`ai_chat.html` → `api/ai_chat.php` → xAI Grok → `api/add_exercises.php`), and an admin interface for manual generation (`admin_manual.php` → `api/admin_manual_trigger.php` → `grok_manual_dump.php`). User auth via `api/auth/*.php`. Data stored per-user in MySQL.

```
High-level Architecture (ASCII)

UI (index.html/ai_chat.html/login.html/admin_manual.php)
  ↓ JS (main.js/lib/*.js/ai_chat.js)
  ↓ fetch()
PHP API (api/*.php) ──┬→ DB (MySQL: users/workouts/workout_sets/exercises/etc.)
                      ↓ (ai_chat.php/add_exercises.php)
                      → xAI Grok API (api/ai_chat.php)
  ↑ json_ok()/json_err() (via api/db.php)
  ↑ JS state/render (Three.js + heat engine)
```

## 1) Directory/Module Map

- **Root**: `index.html` (main app), `ai_chat.html` (AI exercise builder), `login.html` (auth), `admin_manual.php` (manual generator UI), `style.css` (global styles), `ai_chat.css` (AI-specific styles).
- **lib/**: JS modules.
  - `api.js`: API constants/endpoints, `apiJson()` helper.
  - `exercises.js`: Cached exercises list (`./api/exercises_list.php` or `get_exercises.php`).
  - `heat_engine.js`: Computes muscle heat from logs (`rebuildNow()`, `tick()`); supports overall/workout modes, sensitivity.
  - `muscleMap.js`: `classifyMeshName()` maps GLB mesh names to groups (e.g., "triceps"); `GROUPS` array defines muscles.
  - `recovery.js`: `computeHeat()`, `applyStimulus()`, decay logic.
  - `recs.js`: `generateRecs()` for recommendations.
  - `renderer3d.js`: `createRenderer3D()` (Three.js scene, picking, heat painting).
  - `set_timers.js`: Per-set rest timers (`createSetTimerManager()`).
  - `utils.js`: Helpers (`parseSqlDateTime`, `fmtMMSS`, etc.).
  - `workout_*.js`: UI logic (`workout_ui.js` orchestrates editor/history/timers).
- **api/**: PHP endpoints (all require `api/db.php` for session/DB/auth).
  - `db.php`: Session, PDO (`$pdo`), `json_ok()`/`json_err()`, `require_user_id()`.
  - `auth/*.php`: `login.php`, `register.php`, `logout.php`.
  - `workout/*.php`: CRUD for workouts/sets (`start.php`, `add_set.php`, etc.); `_lib.php` helpers.
  - `ai_chat.php`: xAI integration, exercise proposal schema.
  - `add_exercises.php`: Inserts AI-proposed exercises.
  - `ai_upload.php`: Image upload for AI (tokens in `/uploads/ai_tmp/u{uid}/`).
  - Admin: `admin_manual_trigger.php` (runs `grok_manual_dump.php`).
- **Admin tools**: `grok_manual_dump.php` (scans files/DB, generates this manual via xAI), `admin_manual.php` (UI).
- **Other**: `uploads/` (AI images), `logs/` (errors), `assets/models/` (GLB models), vendor/ (Three.js).

## 2) Data Model (tables + key fields)

From DB dump (via `api/db.php`):

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `users` | User accounts | `id` (PK/AI), `email` (unique), `password_hash`, `created_at`/`updated_at`. |
| `workouts` | Workout sessions | `id` (PK/AI), `user_id` (FK), `started_at`/`ended_at` (datetime), `auto_closed` (bool), `created_at`/`updated_at`. Indexes: active/latest by user. |
| `workout_sets` | Individual sets | `id` (PK/AI), `workout_id` (FK), `user_id`, `exercise_id`/`exercise_name`, `reps` (int), `load_lbs` (dec), `stimulus` (dec), `completed` (bool), `muscles_json` (JSON weights), `created_at`/`updated_at`. |
| `exercises` | Exercise catalog (per-user) | `id` (PK/AI), `user_id`, `exercise_key` (unique w/ user), `name`, `weights_json` (JSON: {group:weight}), `source` ('user'/'ai'), `is_active` (bool), timestamps. Backups exist (e.g., `exercises_backup_*`). |
| `exercise_prefs` | Per-exercise settings | `user_id`/`exercise_key` (PK), `prefs_json` (e.g., {"timer_enabled":true,"timer_secs":60}), `updated_at`. |
| `muscle_sensitivity` | Per-muscle calibration | `user_id`/`group_id` (PK/unique), `sensitivity` (float 0.05-1.5), `updated_at`. |

Legacy: `workout_logs` (flat logs, not used in new workout model).

Invariants: Per-user isolation (`user_id` FKs), `weights_json` (snake_case keys, 0-1 floats), `stimulus` (computed from reps/load).

## 3) API Endpoints (path, method, request JSON, response JSON, errors)

All via `apiJson()` helper (401→login.html). Use `require_user_id()` (sets `GLOBAL_USER_ID`).

| Path | Method | Req JSON | Res JSON | Errors |
|------|--------|----------|----------|--------|
| `/api/auth/login.php` | POST | `{email, password}` | `{ok:true, user_id:int}` | `bad_email`, `bad_password`, `invalid_credentials` (401). |
| `/api/auth/register.php` | POST | `{email, password}` | `{ok:true, user_id:int}` | `bad_email`, `bad_password`, `email_taken` (409), `hash_fail`. |
| `/api/auth/logout.php` | POST | - | `{ok:true}` | - |
| `/api/workout/status.php` | GET | - | `{ok:true, active:{id,started_at,ended_at,auto_closed,summary:{sets_count,exercises_count,total_reps}}}` or `{active:null}` | Unauthorized (401). |
| `/api/workout/start.php` | POST/GET | - | `{ok:true, workout:{id,started_at,ended_at,auto_closed,summary}}` | - |
| `/api/workout/end.php` | POST/GET | - | `{ok:true, ended:bool, workout_id, ended_at, summary}` or `{ended:false}` | - |
| `/api/workout/get_current.php` | GET | - | `{ok:true, active:Workout, sets:[Set]}` | - |
| `/api/workout/add_set.php` | POST | `{exercise_id,exercise_name,reps,load_lbs?,stimulus,completed?,muscles?}` | `{ok:true, set:Set, summary}` | No active workout (409). |
| `/api/workout/update_set.php` | POST | `{set_id, reps?,load_lbs?,stimulus?,completed?,muscles?}` | `{ok:true, updated:bool, summary}` | `bad_set_id`, no fields, not found (404). |
| `/api/workout/delete_set.php` | POST | `{set_id}` | `{ok:true, deleted:bool, summary}` | Not found (404). |
| `/api/workout/delete_sets_for_exercise.php` | POST | `{exercise_id}` | `{ok:true, deleted:int, workout_id, exercise_id, summary}` | No active (409). |
| `/api/workout/get_workout.php?id={id}` | GET/POST | `{id}` (POST) | `{ok:true, workout:Workout, sets:[Set]}` | Not found (404). |
| `/api/workout/list_workouts.php?page=&per=` | GET | Query params | `{ok:true, page, pages, per, total, workouts:[{id,started_at,ended_at,auto_closed,summary}]}` | - |
| `/api/workout/get_last_sets_for_exercise.php?exercise_id=&last_completed_only?` | GET | Query params | `{ok:true, workout_id?, sets:[Set], last_completed_set:Set?}` | - |
| `/api/exercises_list.php` / `get_exercises.php` | GET | - | `{ok:true, exercises:[{id, name, w:{group:float}}]}` | - |
| `/api/exercise_prefs.php` | GET/POST | `{exercise_key?, prefs?, map?}` (POST) | GET: `{ok:true, map:{ex_key:{timer_enabled?,timer_secs}}}` POST: `{ok:true, saved:int}` | `bad_json`, `missing_*`. |
| `/api/muscle_sensitivity.php` | GET/POST | `{group_id?, sensitivity?, map?}` (POST) | GET: `{ok:true, map:{group:float}}` POST: `{ok:true, saved:int}` | `missing_*`. |
| `/api/ai_upload.php` | POST | Multipart `image` | `{ok:true, token, mime, url}` (to `/uploads/ai_tmp/u{uid}/{token}.ext`) | `missing_image`, `too_large` (413), `bad_image_type` (415). TTL 24h cleanup. |
| `/api/ai_chat.php` | POST | `{history?, text?, image_tokens[]}` | `{ok:true, assistant:{text, reply:{type,proposal?,proposals?},raw_json}, history}` | `missing_input`, xAI errors (502). |
| `/api/add_exercises.php` | POST | `{id, name, w:{}, source?}` | `{ok:true}` | `bad_id`, `bad_name`, `bad_weights`, `empty_weights`. |
| `/api/admin_manual_trigger.php` | POST | Payload for `grok_manual_dump.php` | `{ok:true, exit_code, duration_ms, output, script_json?, runner}` | Admin-only (403). |
| `/api/log_workout.php` (legacy) | POST | `{date,exercise_id,name,sets,reps,stimulus,muscles,load_lbs?}` | `{ok:true, workout_id, inserted_sets, summary}` | `bad_*`. |

Errors: `json_err()` (400/500, logged w/ user_id), HTTP codes.

## 4) Frontend Flow (pages, JS modules, how calls happen)

- **index.html** (`main.js`): Loads Three.js, `createRenderer3D()` (load GLB, raycast picking via `classifyMeshName()`), `createHeatEngine()` (logs→muscle heat), `createWorkoutUI()` (editor/history/timers). Loop: `animate()` ticks decay/paint/recs. Flow: Status poll → workout UI → add_set/update_set → heat rebuild/paint.
- **ai_chat.html** (`ai_chat.js`): Chat UI w/ image upload (`api/ai_upload.php`), chat (`api/ai_chat.php`), accept→`api/add_exercises.php`→redirect index w/ `?new_ex={key}` (preselects in `exerciseSelect`).
- **login.html**: Auth forms → `api/auth/*.php` → session → index.html.
- **admin_manual.php**: UI → `api/admin_manual_trigger.php` → `grok_manual_dump.php` (scan files/DB → xAI → MANUAL.md).
- JS orchestration: `main.js` wires modules; `lib/workout_ui.js` owns workout state/CRUD; heat via `lib/heat_engine.js` (workout/overall modes).

## 5) AI Intake / MMJ schema explanation (if present)

Present in `api/ai_chat.php` (system prompt). xAI Grok classifies images/text → JSON reply:

Schema:
```
{
  "type": "error|question|exists|propose_add|propose_add_many",
  "text": str,
  "choices"?: [str],
  "id"?: str (exercise_key),
  "name"?: str,
  "proposal"?: {exercise_key:str, name:str, weights:{group_id:float,...}, confidence:float},
  "proposals"?: [Proposal]
}
```
- Loads user exercises (`SELECT ... WHERE user_id=? AND is_active=1`).
- Validates: snake_case keys (allowed: abs_upper/etc.), weights 0-1, exact match check.
- Images: `/uploads/ai_tmp/u{uid}/{token}.ext` → data:URLs (budget 9MB raw).
- Flow: `ai_chat.js` → POST → PHP → xAI → normalize → `ai_chat.js` renders cards → accept→`add_exercises.php`.

No "MMJ schema" found in provided files.

## 6) How to Extend

- **New exercise**: AI (`ai_chat.html`) or manual DB insert (`exercises`: `exercise_key`, `name`, `weights_json`). List via `exercises_list.php`. AI proposals validated/inserted via `add_exercises.php`.
- **New muscle group**: Edit `lib/muscleMap.js` `GROUPS` array (id,label,tokens). Update `classifyMeshName()`. Sensitivity via `api/muscle_sensitivity.php`. Allowed in AI: hardcoded list in `ai_chat.php`.
- **New endpoint**: Add `api/new.php` (req `api/db.php`), use `json_ok()`/`json_err()`. Wire JS in `lib/api.js`.
- **New workout feature**: Extend `lib/workout_ui.js`/`workout_editor.js` (e.g., add fields to `add_set.php` req).
- **New heat/recovery**: Modify `lib/heat_engine.js` `rebuildMuscleFromLogs()` or `lib/recovery.js` `computeHeat()`.

## 7) Troubleshooting (common errors, logs, permissions, DB)

- **401 Unauthorized**: Session expired → login.html. Check `api/db.php` `current_user_id()`.
- **API non-JSON/500**: Logs `/logs/errors-*.log` (daily rotation via `api/db.php`). DB connect fail → `db_unavailable`.
- **No heat/workouts**: Check `api/workout/status.php`, autoclose (5h in `_lib.php`). Permissions: all endpoints req `user_id>0`.
- **Model missing**: GLB in `assets/models/body.glb` (fallback draco). Picking fails → `lib/muscleMap.js` `classifyMeshName()`.
- **AI fails**: xAI key `/etc/musclemap/xai_api_key`, images TTL 24h (`ai_upload.php`). Proposals rejected → weights validation.
- **Admin/manual**: user_id=1 only (`admin_manual.php`). `grok_manual_dump.php` scans files/DB.
- **DB issues**: Per-user (`user_id` FKs CASCADE). Backups: `exercises_backup_*`.

## 8) Q&A

_Questions and answers are appended here over time._

## Q&A

_Questions and answers are appended here over time._

### Q: what tables exist?
From the DB dump (generated via `grok_manual_dump.php` `buildDbDumpTextViaAppDb()` using `api/db.php` PDO), the tables are:

- `exercise_prefs`
- `exercises`
- `exercises_backup_2026_01_28`
- `exercises_backup_fix`
- `exercises_old`
- `muscle_sensitivity`
- `users`
- `workout_logs` (legacy, noted in manual as "flat logs, not used in new workout model")
- `workout_sets`
- `workouts`

These match the manual's "Data Model" section (## 2), which details active tables (`users`, `workouts`, `workout_sets`, `exercises`, `exercise_prefs`, `muscle_sensitivity`) + legacy/backups. No other tables found. Inspect `grok_manual_dump.php` DB dump or run `SHOW TABLES;` in MySQL for full schema.

### Q: can you see what is inside?
Yes, based on the provided files and DB dump:

- **Files**: Full contents of key project files (e.g., `admin_manual.php` UI for manual generation, `api/admin_manual_trigger.php` PHP runner, `grok_manual_dump.php` xAI-powered manual/DB scanner, `MANUAL.md` current manual, `index.html`/`ai_chat.html` UIs, `lib/*.js` modules like `workout_ui.js`/`heat_engine.js`, `api/*.php` endpoints like `ai_chat.php`/`workout/*.php`, `style.css`). Excludes vendor/logs/uploads/assets/models (per `grok_manual_dump.php` `collectFiles()` rules).

- **DB (via `api/db.php` dump)**: 10 tables (`exercise_prefs`, `exercises`, backups like `exercises_backup_*`, `muscle_sensitivity`, `users` (1 row: user_id=1), `workout_logs` legacy (39 rows), `workout_sets` (163 rows with sets data), `workouts` (23 rows)). Samples show seed exercises (e.g., "bench_press": {"chest":0.9,...}), user workouts/sets (e.g., "fixed_lat_pulldown" 10x100lbs), prefs/timers, sensitivities (e.g., "biceps":0.25). No sessions/messages/images tables found.

Full details in DB dump sections (SHOW CREATE TABLE, columns/indexes/samples). Inspect `grok_manual_dump.php` `buildDbDumpTextViaAppDb()` or run `SHOW TABLES; DESCRIBE table;` for schema. No other contents (e.g., no images/uploads scanned).

### Q: How to make it so that grok_manual_dump.php can have the ai query the sql to get data (only using select) after a user lets it happen so that more context be gathered, how to add a reasoning propogation step, and I also want to add to debug mode for the output to show how much each query / manual generated used tokens in and tokens out, also there is no point for use existing manual because we now have a chat and a preview manual, which should really be load manual because we have a chat, and last run output should be like a console with a clear button that new data appears at the bottom and new data appears at the top, it should be live, give detailed instructions a python list FILES = [] that need to be fixed including manual
**Not fully supported by provided files.** `grok_manual_dump.php` already dumps static DB schema/samples via `buildDbDumpTextViaAppDb()` (using `api/db.php` PDO for `SHOW TABLES/CREATE/INDEXES/SAMPLE_ROWS`), but no dynamic SELECT querying by AI (no query endpoint/parser). xAI responses include `usage` (prompt_tokens/completion_tokens/total_tokens) but not captured in debug. `admin_manual.php` has basic polling stub in `admin_manual_trigger.php` (status endpoint tails logs), but no live console/clear. No "reasoning propagation" (e.g., chain-of-thought multi-round). UI has "use existing manual" checkbox (passed as `--use-existing-manual=1`), but chat always uses it.

To implement:

#### 1. **Dynamic SQL Querying (AI-initiated SELECT only, user-approved)**
   - **New PHP endpoint `api/manual_sql_query.php`** (admin-only, user_id=1):
     ```php
     <?php // api/manual_sql_query.php
     require __DIR__.'/db.php'; if(require_user_id()!==1) json_err('admin_only',403);
     $q=trim($_POST['query']??''); if(!preg_match('/^\s*SELECT\b/is',$q)) json_err('select_only',400);
     try{ $stmt=$pdo->query($q); $rows=$stmt->fetchAll(PDO::FETCH_ASSOC); json_ok(['rows'=>$rows]); }
     catch(Throwable $e){ json_err('query_fail',500,['err'=>$e->getMessage()]); }
     ?>
     ```
   - **In `grok_manual_dump.php`**:
     - Add `--allow-sql=1` arg (CLI/UI checkbox).
     - New multi-round: After initial prompt, if AI replies `{"need_query":"SELECT ..."}`, ask user (CLI: `y/n?`), exec via new endpoint, append results to context, continue.
     - Prompt AI: "If need DB data: reply `{"type":"query","sql":"SELECT ... LIMIT 10"}`. Else generate manual."

#### 2. **Reasoning Propagation Step (Chain-of-Thought)**
   - **In `grok_manual_dump.php` `xaiChat()`**: Split into phases:
     ```php
     // Phase 1: Reason
     $reasonPrompt = $userPrompt . "\nFirst, reason step-by-step about structure/content needed.";
     $reason = xaiChat(..., $reasonPrompt); // Capture usage
     // Phase 2: Generate (append reason to messages)
     $messages[] = ['role'=>'assistant','content'=>$reason];
     $messages[] = ['role'=>'user','content'=>'Now generate full MANUAL.md based on reasoning.'];
     $md = xaiChat(...);
     ```
   - Log each phase tokens from `$res['usage']`.

#### 3. **Debug Tokens In/Out**
   - **In `grok_manual_dump.php` `xaiChat()`**: Track/return:
     ```php
     $usage = $res['usage'] ?? ['prompt_tokens'=>0,'completion_tokens'=>0,'total_tokens'=>0];
     if($DEBUG) fwrite(STDERR,"Tokens: in={$usage['prompt_tokens']} out={$usage['completion_tokens']} total={$usage['total_tokens']}\n");
     // Sum across rounds, add to JSON output or manual comment.
     ```
   - UI: Append to `#out_pre` via polling.

#### 4. **UI Changes (`admin_manual.php`)**
   - **Remove "use existing manual" checkbox** (no `--use-existing-manual`).
   - **Rename "Preview MANUAL.md" → "Load Manual"** (same func).
   - **Live console for "Last run output"**:
     - Add `<button id="clearOut">Clear</button>` in `.admin-actions`.
     - In `run()`/`chatSend()`: Use async polling (current `pollRun()` stub in files supports `?status=1&run_id=...` tails `/tmp/mm_manual_runs/{run_id}/stdout.json/stderr.log`).
     - Enhance `api/admin_manual_trigger.php`: Add `tail` to response (current has it), JS `setInterval(poll,1000)` appends to `#out_pre` (new lines at bottom via `pre.style.height`, scrollTop).
     - JS `clearOut.onclick=()=>$("out_pre").textContent="";`.

#### 5. **Files to Fix** (Python list):
```python
FILES = [
    "admin_manual.php",           # UI: remove checkbox, rename btn, live console/clear, poll run_id
    "api/admin_manual_trigger.php", # Enhance status/tail for live, add run logs
    "grok_manual_dump.php",       # SQL querying (multi-round + endpoint), reasoning phase, token logging (--debug), remove use_existing logic
    "api/manual_sql_query.php",   # NEW: SELECT-only endpoint (admin-only)
    "MANUAL.md"                   # Update ##6 How to Extend + ##7 Troubleshooting for new features
]
```

**Next inspect**: Run `grok_manual_dump.php --debug=1 --allow-sql=1` manually, check xAI `usage` in responses (`var_dump($res)`). Test polling in `admin_manual.php` JS console. No sessions/images tables (manual correct). For full async/live, add WebSocket if polling lags (`api/ws.php`).
