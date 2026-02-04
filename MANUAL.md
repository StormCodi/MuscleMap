# MuscleMap Developer Manual

## Overview

MuscleMap is a web-based fitness app with a 3D body model (Three.js + Z-Anatomy GLB) for muscle heat maps. Core features: live/past workout logging (`index.html`), recovery heat visualization (36h decay in `lib/heat_engine.js` + `lib/recovery.js`), per-muscle sensitivity calibration (`api/muscle_sensitivity.php`), AI exercise addition (`ai_chat.html` -> `api/ai_chat.php` -> xAI Grok -> `api/add_exercises.php`), per-exercise timer prefs (`api/exercise_prefs.php`). All secured via `api/db.php` (PDO MySQL + sessions). New: hidden admin UI (`admin_manual.php`) for `grok_manual_dump.php` regeneration (user_id=1 only via `api/admin_manual_trigger.php`). No full DB dump; model from queries + DB snapshot.

```
[Browser: index.html/ai_chat.html/login.html/admin_manual.php]
          |
          v
[JS: main.js -> lib/*.js (workout_ui.js orchestrates editor/history/timers; ai_chat.js for AI+3D; heat_engine.js/renderer3d.js)]
          |
          v  (fetch/apiJson)
[PHP: api/*.php (db.php bootstrap -> require_user_id() -> PDO)]
          |
          +-- DB: users/exercises/workouts/workout_sets/muscle_sensitivity/exercise_prefs
          |
          +-- xAI Grok (api/ai_chat.php -> grok-4-0709; MMJ schema enforced)
          |
          +-- Admin: api/admin_manual_trigger.php -> shell_exec(grok_manual_dump.php)
          |
          +-- Uploads: api/ai_upload.php -> /uploads/ai_tmp/u{uid}/{token}.ext (TTL 24h)
          |
          v
[3D: assets/models/body.glb (muscleMap.js classifies meshes)]
```

## 1) Directory/Module Map

```
musclemap/
├── index.html          # Main: 3D viewer + workout editor/history + heat/recommendations
├── ai_chat.html        # AI chat + image upload + 3D proposal preview
├── login.html          # Auth forms (login/register)
├── admin_manual.php    # Hidden admin: UI for grok_manual_dump.php (user_id=1 only)
├── style.css           # Global mobile-first styles
├── ai_chat.css         # AI-specific (chat bubbles/sidebar)
├── main.js             # Orchestrates renderer3d/heat_engine/workout_ui + boot loop
├── lib/
│   ├── api.js          # apiJson() wrapper + API endpoints consts
│   ├── exercises.js    # getAllExercisesCached() -> api/exercises_list.php
│   ├── heat_engine.js  # createHeatEngine(): logs -> muscle state (overall/workout)
│   ├── muscleMap.js    # classifyMeshName(): GLB mesh -> {kind: "gym/shells/ignore", groups:[]}
│   ├── recovery.js     # computeHeat(): load * sens + decay -> {heat, overdo}
│   ├── recs.js         # generateRecs(): neglected/overdo nudges
│   ├── renderer3d.js   # createRenderer3D(): Three.js + raycast + heat paint
│   ├── set_timers.js   # createSetTimerManager(): per-set rest timers (live workout only)
│   ├── utils.js        # fmtElapsed/parseSqlDateTime/escapeHtml
│   ├── workout_editor.js # createWorkoutEditor(): DOM render + interactions
│   ├── workout_history.js # createWorkoutHistory(): paginated list_workouts.php
│   └── workout_ui.js   # createWorkoutUI(): orchestrates editor/history/timers/prefs
├── api/
│   ├── db.php          # PDO + secure session + json_ok/err + require_user_id()
│   ├── auth/           # login.php/register.php/logout.php (users table)
│   ├── workout/        # _lib.php + CRUD: status.php/start.php/end.php/add_set.php etc.
│   ├── add_exercises.php # INSERT/UPDATE exercises (weights_json)
│   ├── ai_chat.php     # xAI Grok: history/images -> MMJ proposals
│   ├── ai_upload.php   # /uploads/ai_tmp/u{uid}/{token}.ext (TTL 24h cleanup)
│   ├── admin_manual_trigger.php # user_id=1 only: shell_exec(grok_manual_dump.php)
│   ├── exercises_list.php # SELECT exercises (user_id + is_active=1)
│   ├── muscle_sensitivity.php # GET/POST {map: {group_id: sens 0.05-1.5}}
│   └── exercise_prefs.php # GET/POST {map: {ex_key: {timer_enabled, timer_secs}}}
└── assets/models/      # body.glb/body.draco.glb (Z-Anatomy)
```

**Hotspots** (tokens): `main.js` (orchestrator), `lib/workout_ui.js` (timers/editor), `ai_chat.js` (AI+3D), `api/ai_chat.php` (Grok+MMJ), `api/db.php` (bootstrap), `admin_manual.php` (admin UI).

## 2) Data Model (tables + key fields)

Inferred from code/queries + DB dump.

- **users**: `id` (PK int), `email` (unique lowercase), `password_hash` (bcrypt), `created_at`/`updated_at` (timestamp)
- **exercises**: `id` (PK int auto), `user_id` (FK), `exercise_key` (unique/user_id snake_case), `name` (≤128), `weights_json` ({"group_id":0.0-1.0}), `source` ("user"/"ai"/"seed"), `is_active` (tinyint), `created_at`/`updated_at` (timestamp); UNIQUE(user_id,exercise_key)
- **workouts**: `id` (PK bigint auto), `user_id` (FK), `started_at`/`ended_at` (datetime nullable), `auto_closed` (tinyint), `created_at`/`updated_at` (datetime)
- **workout_sets**: `id` (PK bigint auto), `workout_id` (FK), `user_id` (FK), `exercise_id` (str), `exercise_name` (str ≤255), `reps` (int), `load_lbs` (decimal(10,2)|null), `stimulus` (decimal(10,6) 0-5), `completed` (tinyint 0/1), `muscles_json` ({"group_id":float 0+}), `created_at`/`updated_at` (datetime)
- **muscle_sensitivity**: `user_id` (FK), `group_id` (snake_case), `sensitivity` (float 0.05-1.5), `updated_at` (timestamp); UNIQUE(user_id,group_id)
- **exercise_prefs**: `user_id` (FK), `exercise_key` (str), `prefs_json` ({"timer_enabled":bool,"timer_secs":int 0-3600}), `updated_at` (datetime); UNIQUE(user_id,exercise_key)
- Legacy: `workout_logs` (not used in active code)

Sessions: `$_SESSION["user_id"]` (int); cookie httponly/samesite=Lax/secure.

## 3) API Endpoints (path, method, request JSON, response JSON, errors)

All require `require_user_id()` (401 unauthorized if missing). Use `json_ok()`/`json_err()`.

- **api/auth/login.php** POST `{email:str, password:str}` -> `{ok:bool, user_id:int}`; errs: bad_json/bad_email/bad_password/invalid_credentials(401)/server_error(500)
- **api/auth/register.php** POST `{email:str, password:str}` -> `{ok:bool, user_id:int}`; errs: +email_taken(409)
- **api/auth/logout.php** POST -> `{ok:true}`

- **api/workout/status.php** GET -> `{ok:true, active:{id:int, started_at:str, ended_at:str|null, auto_closed:int, summary:{sets_count:int, exercises_count:int, total_reps:int}}|null}`; autoclose>5h
- **api/workout/start.php** POST/GET -> `{ok:true, workout:{id:int, started_at:str, ended_at:null, auto_closed:0, summary:{...}}}` (idempotent)
- **api/workout/end.php** POST/GET -> `{ok:true, ended:bool, workout_id:int, ended_at:str, summary:{...}}`
- **api/workout/add_set.php** POST `{exercise_id:str, exercise_name:str, reps:int(1-1000), load_lbs:float|null, stimulus:float(0-5), completed:int(0/1), muscles:{group_id:float}}` -> `{ok:true, set:{id:int,...}, summary:{...}}`; 409 no active
- **api/workout/update_set.php** POST `{set_id:int, reps?:int, load_lbs?:float|null, stimulus?:float, completed?:int(0/1), muscles?:{}}` -> `{ok:true, updated:bool, summary:{...}}`; 404 not found
- **api/workout/delete_set.php** POST `{set_id:int}` -> `{ok:true, deleted:bool, summary:{...}}`
- **api/workout/get_current.php** GET -> `{ok:true, active:{...}, sets:[{id:int, workout_id:int, exercise_id:str, exercise_name:str, reps:int, load_lbs:float|null, stimulus:float, completed:int, muscles:{}, created_at:str, updated_at:str}]}` (active only)
- **api/workout/get_workout.php** GET/POST `?id=int`/`{id:int}` -> `{ok:true, workout:{id:int, started_at:str, ended_at:str|null, auto_closed:int, created_at:str, updated_at:str, summary:{...}}, sets:[...]}`; 404 not found
- **api/workout/list_workouts.php** GET `?page=int(1+),per=int(5-50)` -> `{ok:true, page:int, pages:int, per:int, total:int, workouts:[{id:int, started_at:str, ended_at:str|null, auto_closed:int, created_at:str, updated_at:str, summary:{sets_count:int, exercises_count:int}}]}` (paginated, newest first)

- **api/exercises_list.php** GET -> `{ok:true, exercises:[{id:str(exercise_key), name:str, w:{group_id:float}}]}` (user_id + is_active=1)
- **api/add_exercises.php** POST `{id:str(snake 2-64), name:str(≤128), w:{group_id:float 0-1}, source?:"user"/"ai"}` -> `{ok:true}`; errs: bad_id/bad_name/bad_weights/empty_weights (400), server_error(500); ON DUPLICATE KEY UPDATE
- **api/muscle_sensitivity.php** GET -> `{ok:true, map:{group_id:float}}`; POST `{map?:{group_id:float}, group_id?:str, sensitivity?:float}` -> `{ok:true, saved:int}` (0.05-1.5 clamped)
- **api/exercise_prefs.php** GET -> `{ok:true, map:{exercise_key:{timer_enabled:bool, timer_secs:int}}}`; POST `{map?:{ex_key:{...}}, exercise_key?:str, prefs?:{}}` -> `{ok:true, saved:int}` (0-3600s)
- **api/ai_upload.php** POST multipart `image` (≤4.5MB jpg/png/webp) -> `{ok:true, token:str(32hex), mime:str, url:str(./uploads/...)}`; errs: too_large(413)/bad_image_type(415); per-user TTL 24h cleanup
- **api/ai_chat.php** POST `{history:[{role:"user"/"assistant", text:str, images?:[str]}], text:str, image_tokens:[str(32hex)]}` -> `{ok:true, assistant:{role:"assistant", text:str, reply:{type:"propose_add|propose_add_many|exists|question|error", ...}, raw_json:{}}, history:[...]}`
- **api/admin_manual_trigger.php** POST `{model?:str, out?:str, debug?:0/1, db?:0/1, use_existing_manual?:0/1, chunk_tokens?:int, max_rounds?:int, timeout?:int, question?:str}` (user_id=1 only) -> `{ok:true, exit_code:int, duration_ms:int, output:str, script_json:?}`; errs: access_denied(403), method_not_allowed(405), proc_open_failed(500)

Legacy: `api/get_exercises.php`/`get_logs.php`/`log_workout.php`/`state_reset.php` (commented/not active).

## 4) Frontend Flow (pages, JS modules, how calls happen)

- **login.html**: Forms -> `api/auth/login.php`/`register.php`/`logout.php` (fetch POST JSON) -> redirect index.html
- **index.html** (`main.js` entry):
  1. `getAllExercisesCached()` (`lib/exercises.js` -> `api/exercises_list.php`) -> populate `<select>`, `heat.setExerciseWeightsById()`
  2. `loadSensitivityFromServer()` (`api/muscle_sensitivity.php`) -> `heat.setSensitivityMap()`
  3. `workoutUI.boot()` (`lib/workout_ui.js`): `loadPrefsFromServer()` (`api/exercise_prefs.php`), `refreshStatus()`/`loadCurrentWorkoutSets()` (`api/workout/status.php`/`get_current.php`), `history.refreshHistory()` (`api/workout/list_workouts.php`)
  4. `renderer3d.loadGLBWithFallback()` (`lib/renderer3d.js` + `muscleMap.js` classify) -> raycast pick -> `setSelectedPanel()` (sens UI)
  5. Loop (`animate()`): `workoutUI.tickTimer()` (dur + per-set timers `set_timers.js`), `heat.tick()`/`applyHeatToAllMeshes()` (2s), status poll (15s)
  - Workout: `startWorkout()`/`addExerciseAsOneSet()` (uses `get_last_sets_for_exercise.php` memory) -> `add_set.php` -> `loadCurrentWorkoutSets()`
  - Edit past: history click -> `viewWorkout()` (`get_workout.php`) -> local pending -> `savePastEdits()`
  - Heat: `overallBtn`/`workoutBtn` -> `heat.setMode()`/`rebuildNow()` (paginated workouts -> `rebuildMuscleFromLogs()`)
- **ai_chat.html** (`ai_chat.js`):
  1. Load 3D preview (`renderer3d.js` subset + `muscleMap.js`)
  2. Upload images (`ai_upload.php`) -> tokens/urls
  3. Chat: localStorage history + `{history:[], text:str, image_tokens:[]}` -> `ai_chat.php` (Grok + server MMJ normalize/match) -> render cards (accept -> `add_exercises.php` + redirect index?new_ex=)
  4. Preview: `applyPreviewWeights()` on proposals
- **admin_manual.php** (hidden, user_id=1): Forms -> `api/admin_manual_trigger.php` (shell_exec `grok_manual_dump.php`) -> `<pre>` output + live MANUAL.md preview/chat Q&A append.

## 5) AI Intake / MMJ schema explanation (if present)

Present in `api/ai_chat.php`: xAI Grok ("grok-4-0709") chat with vision (≤6 imgs ≤9MB raw via base64). System prompt enforces **MMJ JSON** (no markdown):

```
{
  "type": "error|question|exists|propose_add|propose_add_many",
  "text": "string",
  "choices": ["str",...],  // question only
  "id": "exercise_key", "name": "str",  // exists
  "proposal": {exercise_key:str(snake), name:str, weights:{group_id:float 0-1 (≤6)}, confidence:float 0-1},
  "proposals": [proposal,... (≤6)]
}
```

- Server normalizes/enforces: snake_key (normalizeId), weights (allowed groups only, ≤6 top, 0-1), exact-match existing exercises -> "exists".
- Allowed groups: abs_upper/lower, obliques_*, core_deep, chest/lats/*_back, shoulders/*_delts, biceps/triceps/forearms, quads/hamstrings/glutes/calves, upper_traps/posterior_chain/core.
- Flow: chat -> proposals -> accept `add_exercises.php` (source:"ai") -> preselect in index.html?new_ex=key.

## 6) How to Extend

- **New exercise**: AI chat (`ai_chat.html`) or manual POST `add_exercises.php` `{id:"snake_key",name:"Pushups",w:{"chest":0.8,"triceps":0.4}}`.
- **New muscle group**: `lib/muscleMap.js` GROUPS[] `{id:"new_group",label:"New",tokens:["mesh","names"]}`; client `lib/recovery.js` handles; server `api/ai_chat.php` $allowedIds[].
- **New endpoint**: `api/new.php`: `require __DIR__."/db.php"; $uid=require_user_id();` + queries + `json_ok($data)/json_err("msg")`. Add to `lib/api.js` const.
- **Admin endpoint**: Like `api/admin_manual_trigger.php`: `require_user_id()===1`, `proc_open(escapeshellcmd("php grok_manual_dump.php ..."))`.
- **New workout field**: ALTER `workout_sets` ADD `new_col TYPE`; update _lib.php validators (`intv/floatv`), get_current/get_workout/list_workouts.
- **New pref**: `api/exercise_prefs.php` clean_prefs() allowlist + prefs_json; `lib/workout_ui.js` getPrefs/setPrefs.
- **New heat mode**: `lib/heat_engine.js` setMode() + rebuildMuscleFromLogs(); `main.js` btn + setHeatMode().

## 7) Troubleshooting (common errors, logs, permissions, DB)

- **401 unauthorized**: Session expired/missing; check `api/auth/login.php`. `db.php` logs "[API_ERR] code=401".
- **Non-JSON/500 server_error**: `/logs/errors-*.log` (daily rotation; `errors.log` symlink). PDO exceptions logged.
- **Upload fail (413/415)**: `api/ai_upload.php` size(4.5MB)/type(jpg/png/webp); per-user `/uploads/ai_tmp/u{uid}/*` 24h TTL.
- **No heat/paint**: `heat.rebuildNow()` (check `api/workout/list_workouts.php` perms); GLB load (`assets/models/body.glb`); `muscleMap.js` classify.
- **Timers wrong**: Live-only (`lib/set_timers.js`); prefs `api/exercise_prefs.php`; `isEditingPast()`.
- **AI no proposals**: Grok key `/etc/musclemap/xai_api_key`; allowed groups; images base64 ≤9MB.
- **Admin 403**: Only user_id=1 (`admin_manual.php`/`api/admin_manual_trigger.php`); check DB `SELECT id FROM users LIMIT 1`.
- **DB**: `mysql:host=localhost;dbname=musclemap;charset=utf8mb4` (creds hardcoded `db.php`); UNIQUE constraints (ex: email/exercise_key).
- **Prod**: `display_errors=0`; all errs -> logs. Test: `curl -b "PHPSESSID=foo" api/workout/status.php`.

## 8) Q&A

_Questions/answers appended over time._

## Q&A

_Questions and answers are appended here over time._

### Q: how does the ui for debuggin manual work?
`admin_manual.php` is a hidden admin UI (accessible only if `require_user_id() === 1` via `api/db.php`; redirects to `login.html?reason=admin` on 403). It provides forms to trigger `grok_manual_dump.php` via `api/admin_manual_trigger.php` (POST JSON payload with params like `model`, `out`, `debug`, `db`, `use_existing_manual`, `chunk_tokens`, `max_rounds`, `timeout`, `question`).

**Runner settings form** (`#model`, `#out`, etc.):
- Defaults: `grok-4-1-fast-reasoning`, `MANUAL.md`, `chunk_tokens=12000`.
- "Regenerate / Print" (`#btn_run`): Builds `buildBasePayload()`, POSTs to `api/admin_manual_trigger.php` (no `question`), displays `data.output` in `#out_pre`, fetches `./MANUAL.md` for `#manual_pre`.
- "Preview MANUAL.md" (`#btn_preview`): `fetchManual()` loads `./MANUAL.md` into `#manual_pre`.

**Q&A Chat** (`#chat_log`, `#chat_text`, `#chat_send`/`#chat_clear`):
- LocalStorage `mm_admin_chat` for history (`chatLoad`/`chatSave`/`chatRender`).
- "Send": Appends user msg to history, builds payload (`use_existing_manual=1`, `question=text`), POSTs to `api/admin_manual_trigger.php`.
- Response: Parses `data.script_json.output` (markdown Q&A block from `grok_manual_dump.php --question`), appends to chat history + `#out_pre`, refreshes `#manual_pre`.
- Ctrl+Enter sends; clears history on `#chat_clear`.

`api/admin_manual_trigger.php`: Validates `user_id===1`, builds `escapeshellcmd("php grok_manual_dump.php ...")` args (e.g. `--json=1 --question=...`), `proc_open()` runs in project root, returns `{ok:true, exit_code, duration_ms, output, script_json}` (stderr prefixed). Errors: 403/405/500.

Manual updates happen server-side via `grok_manual_dump.php` (appends Q&A under "## Q&A" when `--question` + `--use-existing-manual=1`). JS shows live preview/chat but doesn't write files client-side. No auth beyond `user_id=1`; no rate limits visible. Inspect `admin_manual.php` JS (`fetch("./api/admin_manual_trigger.php")`) + PHP `proc_open()` for flow; check `/logs/errors-*.log` for failures.

### Q: does the chat load from the manual or is it stored in memory?
The Q&A chat history in `admin_manual.php` is stored client-side in `localStorage` under key `"mm_admin_chat"` (`chatLoad()`/`chatSave()`/`chatRender()` functions). It persists across page reloads/sessions but is browser-local (not shared/server-side).

- **Not loaded from manual**: Chat history is independent; `fetchManual()` separately loads `./MANUAL.md` into `#manual_pre` for preview.
- **Responses generated server-side**: On "Send", it POSTs `{..., question: text, use_existing_manual:1}` to `api/admin_manual_trigger.php` -> `proc_open("php grok_manual_dump.php --question=...")` -> appends new Q&A block to server-side `MANUAL.md`.
- **UI flow**: User msg → localStorage append → server appends to manual → response parsed from `data.script_json.output` → localStorage append → render chat + refresh manual preview.
- **Clear**: `#chat_clear` resets localStorage only (manual unchanged).

Inspect `admin_manual.php` JS (`chat*()` funcs + `chatSend()`) + `localStorage.mm_admin_chat`; manual appends visible in `./MANUAL.md`. No server-side chat storage found.

### Q: as I was using the app I took a few notes, for example when you add a new set that was not remembered from the last workout (say last time it was 3 sets you add a 4th) it should just copy it from the last set checked off no matter what workout, also when you have 3 sets setup and you change one thing on the top one and none of the other ones are not checked off it changes all of the ones below it to be the same, if one is checked off it doesn't, also add a remove exercise button that basically deletes all the exercises, also make it so that once you add an exercise from the drop down it disappears in the drop down or is just marked used, tell me what files are needed to change for this to be implemented and what files contain crucial context to implement this change in a python list FILES = [], and explain what each file changed needs changed in it
**Not found in provided files: No explicit "propagate changes to unchecked sets below" logic (e.g., no code in `lib/workout_editor.js` or `lib/workout_ui.js` that copies input values between unchecked set rows). Inspect `lib/workout_editor.js` `wireInteractions()` (input change handlers call `applyLocalPatch()` + `pushPendingOrLive()` per-row only) and `lib/workout_ui.js` `addExerciseAsOneSet()` (uses server `get_last_sets_for_exercise.php` memory, no client-side propagation). This behavior may be emergent or absent; confirm via browser devtools on live app. No "remove exercise" button/DOM/event in `index.html`/`lib/workout_editor.js`. No used-exercise tracking in `lib/exercises.js`/`main.js` dropdown population.**

To implement:

```python
FILES = [
    # 1. Change "copy last checked-off set across workouts" (not just last workout)
    "api/workout/get_last_sets_for_exercise.php",
    
    # 2. Add "remove exercise" button (delete all sets for exercise_id)
    "lib/workout_editor.js",
    "api/workout/delete_sets_for_exercise.php",  # New endpoint (or extend delete_set.php)
    
    # 3. Hide/mark used exercises in dropdown (track active workout exercises client-side)
    "lib/workout_ui.js",
    "main.js",
    
    # 4. Propagation clarification: No change needed (per-row only); if desired, add to workout_editor.js
    # Crucial context (read-only):
    "lib/workout_ui.js",  # Orchestrates addExerciseAsOneSet() + viewingSets
    "main.js",            # exerciseSelect population + addExerciseAsOneSet()
    "api/workout/add_set.php",  # Set insertion (called by ui)
    "api/workout/_lib.php",     # workout_summary(), get_active_workout()
]
```

**Detailed changes:**

1. **`api/workout/get_last_sets_for_exercise.php`** (modify query for last *completed* set across *all* past workouts, not just last workout):
   - Current: Queries most recent closed workout with this exercise_id, returns its sets (up to 20).
   - Change: Add `AND completed=1` to `workout_sets` JOIN; ORDER BY `created_at DESC LIMIT 1` on sets (not workouts) to get global most recent completed set. Return single set or fallback `{reps:10,load_lbs:null}`. Test: Ensure excludes active workout (`get_active_workout()`). Crucial: Retain `exclude active workout` logic.

2. **`lib/workout_editor.js`** (add "Remove exercise" button per `.excard`; batch-delete sets via new endpoint):
   - In `render()`: Add `<button class="iconbtn bad removeExBtn" title="Remove exercise">🗑</button>` to `.excard-actions`.
   - In `wireInteractions()`: `.removeExBtn` click → confirm → collect `data-setid` from `.sets .setrow`, call new `api/workout/delete_sets_for_exercise.php?exercise_id=...` (POST `{sets:[id1,id2,...]}` or single exercise_id), then `onAfterLiveMutation()`. For past edits: Add to `pending.deletes`. Update `groupSetsByExercise()` post-delete.

3. **`api/workout/delete_sets_for_exercise.php`** (new file; batch delete):
   - `require __DIR__."/workout/_lib.php";` → `user_id()`.
   - POST `{exercise_id:str}` or `{sets:[int]}` → `DELETE FROM workout_sets WHERE workout_id=? AND exercise_id=?` (live) or `WHERE id IN(...)` (past). Touch `workouts.updated_at`. Return `{ok:true, deleted:int, summary:{...}}`. Errors: 404 no sets, 409 no active.

4. **`lib/workout_ui.js`** (track used exercises for dropdown filter):
   - Add `usedExerciseIds = new Set();` → populate from `getViewingSets()` `exercise_id` (live/past).
   - In `addExerciseAsOneSet()` post-add: `usedExerciseIds.add(exId)`.
   - Expose `getUsedExerciseIds()` → call from `main.js` to filter dropdown options (hide `option[value=used]` or `disabled`).

5. **`main.js`** (filter dropdown on used exercises):
   - After `getAllExercisesCached()`: Listen `workoutUI.onEditorSetsChanged` → `filterExerciseDropdown(workoutUI.getViewingSets())`.
   - `filterExerciseDropdown(sets)`: `used = new Set(sets.map(s=>s.exercise_id))`; toggle `option.disabled` or `hidden` for matches (preserve `__newExFromAi` preselect).

**Crucial context files (read before changing):**
- `lib/workout_ui.js`: Owns `addExerciseAsOneSet()` (calls `get_last_sets_for_exercise.php`), `getViewingSets()`, orchestrates editor/history/timers.
- `main.js`: Populates `exerciseSelect`, calls `workoutUI.addExerciseAsOneSet()`, heat integration.
- `api/workout/add_set.php`/`update_set.php`: Single-set CRUD (batch-delete new).
- `api/workout/_lib.php`: `get_active_workout()`, `workout_summary()` (reuse for delete response).
- `lib/workout_editor.js`: Current set row wiring (`repsInput`/`loadInput` changes are per-row via `applyLocalPatch()`; no propagation found—add if desired via shared `lastUncheckedValuesByEx`).

**Edge cases/invariants:**
- Live vs past: Propagation/live-delete only if `!getViewingWorkoutId()`; past uses `pending`.
- Permissions: All via `require_user_id()`/`user_id()`.
- Validation: Reuse `_lib.php` `intv()`/`floatv()` for reps/load.
- UI: Mobile-safe (iconbtns); refresh editor/history post-change.
- Test: Active workout add (memory), past edit (pending), dropdown filter (live/past). Inspect next: Browser console on input changes for emergent propagation.
