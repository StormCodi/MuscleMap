# MuscleMap Developer Manual

## Overview

MuscleMap is a web-based fitness app with 3D muscle visualization (Three.js + Z-Anatomy GLB). Features: workout logging (sets/reps/load/stimulus/completed/muscles), muscle heat maps (36h decay in `lib/heat_engine.js`/`lib/recovery.js`), per-muscle sensitivity (`api/muscle_sensitivity.php`), exercises (`api/exercises_list.php`/`api/add_exercises.php`), workout CRUD (`api/workout/*`), AI proposals (`ai_chat.html` via `api/ai_chat.php`/xAI), per-exercise prefs/timers (`api/exercise_prefs.php`). Auth: sessions (`api/auth/*.php`). Per-user MySQL. Images: temp `uploads/ai_tmp/u{user_id}/{token}.{ext}` (24h TTL). New: exercise cards w/+sets/checkmarks/timers/memory (Phase 2-4 in `lib/workout_ui.js`).

```
+-------------------+    +----------------+    +----------------+    +------------+
|   Frontend        |    |    JS Modules  |    |    PHP API     |    |   MySQL    |
| (index.html,      |<-->| (lib/*.js,     |<-->| (api/*.php,    |<-->| (per-user  |
|  ai_chat.html)    |    |  main.js)      |    |  db.php)       |    |  tables)   |
+-------------------+    +----------------+    +----------------+    +------------+
         |                      |                      |                    |
         | Three.js (renderer3d)| Heat/recovery,      | Auth/sessions,    | users: id/email/pass_hash
         |                       | workout_ui (CRUD+   | Workouts/sets/    | exercises: user_id/key/name/weights_json/source/active
         +-----------------------+ timers/prefs)       | exercises/prefs   | workouts: id/user_id/started_at/ended_at/auto_closed
                                       |                      | sensitivity       | workout_sets: id/workout_id/user_id/exercise_id/name/reps/load/stim/completed/muscles_json
                                       | xAI (ai_chat.php)   +-------------------+ muscle_sensitivity: user_id/group_id/sens
                                       +----------------------+        |        exercise_prefs: user_id/exercise_key/prefs_json
```

## 1) Directory/Module Map

- **Root**: `index.html` (3D+workout+history), `ai_chat.html` (AI chat/uploads/preview), `login.html` (auth), `style.css`, `ai_chat.css`.
- **lib/** (ES modules):
  - `api.js`: `API` consts, `apiJson()` (fetch+401→login).
  - `exercises.js`: `getAllExercisesCached()` (`api/exercises_list.php`).
  - `heat_engine.js`: `createHeatEngine()` (logs/muscle/sens, `buildOverallLogsCapped()` paginates workouts).
  - `muscleMap.js`: `classifyMeshName(name)` (GLB→groups), `GROUPS` (27 ids).
  - `recovery.js`: `computeHeat()`/`applyStimulus()`/`tickDecay()` (36h half-life, sens multiplier).
  - `recs.js`: `generateRecs()` (warnings/nudges from heat/neglect).
  - `renderer3d.js`: `createRenderer3D()` (scene/controls/pick/heat paint).
  - `storage.js`: LS `musclemap.v1` (legacy).
  - `workout_ui.js`: `createWorkoutUI()` (editor/history/CRUD/timers/prefs via `api/workout/*`/`exercise_prefs.php`).
- **api/**:
  - `db.php`: PDO (`musclemap`), sessions/logging (`/logs/errors-*.log`), `require_user_id()`.
  - `auth/*.php`: `login.php`/`register.php`/`logout.php`.
  - `exercises_list.php`/`get_exercises.php`: Active exercises (user_id).
  - `add_exercises.php`: UPSERT `exercises` (weights_json 0-1).
  - `muscle_sensitivity.php`: GET/POST {group:float 0.05-1.5}.
  - `exercise_prefs.php`: GET/POST per-ex {timer_enabled:bool, timer_secs:int 0-3600}.
  - `ai_upload.php`: Images→`uploads/ai_tmp/u{uid}/{token}.{ext}` (4.5MB jpg/png/webp, 24h TTL).
  - `ai_chat.php`: xAI Grok (history/images→proposals schema).
  - `workout/*.php`: CRUD (`start`/`end`/`add_set` w/completed/`update_set`/`delete_set`/`get_current`/`get_workout`/`list_workouts` page/per, autoclose 5h).
- **ai_chat.***: AI page (3D preview `applyPreviewWeights()`, accept→`add_exercises`+redirect `?new_ex=`).

## 2) Data Model (tables + key fields)

Inferred from queries (no DB dump):

- **users**: `id`(PK/int), `email`(unique/str), `password_hash`(str).
- **exercises**: `user_id`(FK), `exercise_key`(unique w/user_id, snake), `name`(str<=128), `weights_json`(JSON {group:0-1}), `source`("user"/"ai"), `is_active`(bool), `updated_at`(ts).
- **workouts**: `id`(PK), `user_id`(FK), `started_at`/`ended_at`(datetime NULL=active), `auto_closed`(bool), `created_at`/`updated_at`(ts).
- **workout_sets**: `id`(PK), `workout_id`(FK), `user_id`(FK), `exercise_id`/`exercise_name`(str), `reps`(int>0), `load_lbs`(float/NULL), `stimulus`(float0-5), `completed`(tinyint0/1 def1), `muscles_json`(JSON {group:float>0}), `created_at`/`updated_at`(ts).
- **muscle_sensitivity**: `user_id`(FK), `group_id`(str), `sensitivity`(float0.05-1.5), `updated_at`(ts). UNIQUE(user_id,group_id).
- **exercise_prefs**: `user_id`(FK), `exercise_key`(unique), `prefs_json`(JSON {timer_enabled:bool,timer_secs:int}), `updated_at`(ts).

Invariants: user_id FKs (isolation), JSON validated, workouts autoclose (`_lib.php`), list_workouts filters `EXISTS workout_sets`.

## 3) API Endpoints

JSON, sessions (`require_user_id()`→401), `db.php` logging.

| Path | Method | Request JSON | Response JSON | Errors |
|------|--------|--------------|---------------|--------|
| `/api/auth/login.php` | POST | `{email:str, password:str}` | `{ok:bool, user_id:int}` | 400 bad_json/email/password, 401 invalid_credentials, 500 |
| `/api/auth/register.php` | POST | `{email:str, password:str>=6}` | `{ok:bool, user_id:int}` | 400/409 email_taken/500 |
| `/api/auth/logout.php` | POST | - | `{ok:true}` | - |
| `/api/exercises_list.php` `/api/get_exercises.php` | GET | - | `{ok:bool, exercises:[{id:str, name:str, w:{group:0-1}}]}` | 500 |
| `/api/add_exercises.php` | POST | `{id:snake2-64, name:str<=128, w:{group:0-1}, source?:"user/ai"}` | `{ok:bool}` | 400 bad_id/name/weights, 500 |
| `/api/muscle_sensitivity.php` | GET | - | `{ok:bool, map:{group:float0.05-1.5}}` | 405/500 |
| | POST | `{map:{group:float}}`/`{group_id:str, sensitivity:float}` | `{ok:bool, saved:int}` | 400 missing_group_id_or_map |
| `/api/exercise_prefs.php` | GET | - | `{ok:bool, map:{ex_key:{timer_enabled:bool, timer_secs:int}}}` | 405/500 |
| | POST | `{exercise_key:str, prefs:{timer_enabled:bool, timer_secs:int}}`/`{map:{ex_key:prefs}}` | `{ok:bool, saved:int}` | 400 bad_key/prefs |
| `/api/ai_upload.php` | POST | Multipart `image` (<=4.5MB jpg/png/webp) | `{ok:bool, token:str32hex, url:str, mime:str}` | 400/405/413/415 upload_error/too_large/bad_type |
| `/api/ai_chat.php` | POST | `{history:[{role,text,images?}], text:str?, image_tokens:[str32hex max6]}` | `{ok:bool, assistant:{text:str, reply:{type,proposal?}, raw_json:{}}, history:[]}` | 400 bad_json/missing_input, 500 xai/db/json |
| `/api/workout/status.php` | GET | - | `{ok:bool, active?{id,started_at,ended_at,auto_closed,summary{sets_count,exercises_count}}}` | 401/500 |
| `/api/workout/start.php` | POST/GET | - | `{ok:bool, workout{id,started_at,summary}}` | 401/500 |
| `/api/workout/end.php` | POST/GET | - | `{ok:bool, ended:bool, workout_id?,summary}` | 409 no_active |
| `/api/workout/add_set.php` | POST | `{exercise_id:str, exercise_name:str, reps:int>0, load_lbs?:float|null, stimulus:0-5, completed?:0/1, muscles:{group:float>0}}` | `{ok:bool, set{id,...}, summary}` | 400 missing/bad, 409 no_active |
| `/api/workout/update_set.php` | POST | `{set_id:int>0, reps?:int, load_lbs?:float|null, stimulus?:float, completed?:0/1, muscles?:{group:float}}` | `{ok:bool, updated:bool, summary}` | 400 no_fields, 404 |
| `/api/workout/delete_set.php` | POST | `{set_id:int>0}` | `{ok:bool, deleted:bool, summary}` | 404 |
| `/api/workout/get_current.php` | GET | - | `{ok:bool, active?, sets:[{id,exercise_id/name,reps,load_lbs?,stimulus,completed,muscles?,created_at}]}` | - |
| `/api/workout/get_workout.php?id=int` | GET/POST `{id:int}` | - | `{ok:bool, workout{...summary}, sets:[]}` | 400 missing_id, 404 |
| `/api/workout/list_workouts.php?page=int&per=5-50` | GET | - | `{ok:bool, page/pages/per/total, workouts:[{id,started_at/ended_at?,auto_closed?,summary}]}` (non-empty only) | 500 |

## 4) Frontend Flow

- **Auth**: `login.html`→`api/auth/login.php`→session→`index.html`/`ai_chat.html` (401→login via `apiJson()`).
- **index.html** (`main.js`): Boot→`getAllExercisesCached()`→`<select>`, `loadSensitivityFromServer()`, `workoutUI.boot()` (status/editor/history), `renderer3d.loadGLBWithFallback()`. Loop: `animate()` (tickTimer/heat/poll 15s). Heat: `heat.rebuildNow()`→`applyHeatToAllMeshes()`. Workout: `workout_ui.js` CRUD→`api/workout/*`→`onEditorSetsChanged(sets)`→`heat.setWorkoutSets()`. Muscle pick→`setSelectedPanel()`→sens UI (`sensSlider` preview→`saveSensitivityForSelected()`). AI redirect: `?new_ex=snake`→preselect if active.
- **ai_chat.html** (`ai_chat.js`): LS history, upload→thumbs (`api/ai_upload`), send (`api/ai_chat`)→parse→3D preview (`applyPreviewWeights()`), accept→`add_exercises`+`redirectToMainWithPreselectIfActive()` (`status.php`→`index.html?new_ex=` if active).
- End-to-end: UI (add_set)→`apiJson()`→PHP (user_id→PDO)→[AI:xAI]→JSON→UI. Heat: workouts→`setsToHeatLogs()`→`rebuildMuscleFromLogs()` (decay/stim*sens).

## 5) AI Intake / MMJ schema explanation

In `api/ai_chat.php` (MMJ=muscle-map JSON).

- Flow: `ai_chat.html` upload (`ai_upload.php`)→chat (`history/text/image_tokens`→PHP)→user exercises→base64 images (9MB)→Grok (`grok-4-0709`, prompt w/exercises/groups)→parse/normalize (exact→"exists", weights/ids validate)→`{reply:{type,proposal?}}`.
- Schema (strict):
  ```
  {"type":"error"|"question"|"exists"|"propose_add"|"propose_add_many","text":str,"choices":[str],"id":str,"name":str,"proposal":{"exercise_key":snake,"name":str,"weights":{group:0-1 max6},"confidence":0-1},"proposals":[proposal]}
  ```
- Groups: 27 fixed (`abs_upper`/`chest`/etc. in `$allowedIds`). Proposals→`add_exercises` (source:"ai").

## 6) How to Extend

- **New exercise**: UI→`api/add_exercises.php` POST `{id:"snake_key",name:"Pushup",w:{chest:0.8,...}}` (UPSERT).
- **New muscle**: `lib/muscleMap.js` `GROUPS`/classify, `api/ai_chat.php` `$allowedIds`, GLB. Sens/prefs auto.
- **New endpoint**: `api/new.php`→`require "db.php"; $uid=require_user_id();`→PDO→`json_ok([...])`. Add `lib/api.js` `API.NEW`.
- **New JS**: ES importmap `lib/new.js`, `main.js`/`ai_chat.js` import.
- **New page**: Copy `index.html`, `<script type=module src=new.js>`.
- **Timers/prefs**: `lib/workout_ui.js` `setPrefs()`→`api/exercise_prefs.php`. Extend `prefs_json`.
- Invalidate: `bustExercisesCache()`, `heat.invalidateOverallCache()`.

## 7) Troubleshooting

- **401**: Session expire→login. `api/db.php` `session_start()`.
- **500/non-JSON**: `/logs/errors-*.log` (daily). PDO→DB/creds.
- **Uploads fail**: `ai_upload.php` mkdir/TTL (`uploads/ai_tmp/u{uid}` 0775).
- **Heat blank**: `heat.rebuildNow()`→empty workouts? `api/workout/list_workouts.php`. Sens: `muscle_sensitivity.php`.
- **AI no proposals**: `/etc/musclemap/xai_api_key`, strict schema.
- **3D fail**: `assets/models/body.glb`. Picking: `pickables` `renderer3d.js`.
- **Timers missing**: `api/exercise_prefs.php` 405→add table. `workout_ui.js` `loadPrefsFromServer()`.
- **DB**: Per-user FKs, UNIQUE(exercises/prefs user_id+key).

## 8) Q&A

_Questions/answers appended over time._

## Q&A

_Questions and answers are appended here over time._

### Q: the time system is ugly and doesnt work, here is how it supposed to work: you have a set and automatically below it there is a timer, when you click the check mark for that set it begins a timer in the bar below, you have a bar shrinking like a loading screen and when its done it like vibrates hte phone or whatever, maybe nothing, the user can hit pause unpuase or x which grays out the bar only with a button to turn it back on, that was the idea behind that timer, we need to implement it fully, tell me what files are necessary to change this both files changing and files offering crucial context, put that list in a single python list named FILES = [], do not put too many files in there only the required ones, remember it has to be nice and not ugly so style it too
**Core files to change (implement per-set timers, checkbox→start, shrinking bar w/pause/X, vibration on end, per-set state):**
- `lib/workout_ui.js` (render per-set timer bars in `renderWorkoutEditor()` / `.setrow`, checkbox `doneChk` onChange→`startTimerForSet(setId)`, `tickRestTimers(now)` animates width via `requestAnimationFrame`, pause/unpause/X buttons, `navigator.vibrate(200)` on end; extend `restTimers` Map to `setId→{running, endAtMs, paused}`; wire in `wireEditorInteractions()`)
- `style.css` (new `.timerbar` styles: `height:4px;background:linear-gradient(90deg,var(--accent),var(--warn));transition:width 0.1s ease;border-radius:2px;`, `.timerbar.paused{opacity:0.4;}`, `.timerbar-controls{display:flex;gap:4px;font-size:11px;}`)

**Supporting files (read for context):**
- `main.js` (`workoutUI.tickTimer(now)` loop calls; integrate timer ticks)
- `lib/api.js` (`API.EXERCISE_PREFS_*` for default timer_secs per ex, fallback 60s)

**New files needed:**
- None (extend existing `restTimers` in `workout_ui.js`; no DB change, client-only per-set)

```python
FILES = [
    "lib/workout_ui.js",
    "style.css",
    "main.js",
    "lib/api.js"
]
```

**Implementation Guide (Phased, ~2-4h):**
**Phase 1: Per-set bars (1h)**: In `renderWorkoutEditor()`, after each `.setrow`, add `<div class="timerbar-wrap"><div class="timerbar"></div><div class="timerbar-controls"><button class="pause">⏸</button><button class="x">✕</button></div></div>`. Default width:100% (full bar).

**Phase 2: Checkbox→Timer (1h)**: `doneChk` change→if `completed=1` && `!restTimers.has(setId)`, `startTimerForSet(setId, defaultSecs=60)` sets `endAtMs=now+secs*1e3`. In `tickRestTimers(now)` (called from `main.js` loop): compute `progress=(now/endAtMs)*100`, set `.timerbar.style.width=`${100-progress}%``. On `remaining<=0`: `vibrate(200)`, highlight next `.setrow` in ex.

**Phase 3: Controls/Styling (1h)**: Pause btn→toggle `paused=true`, gray bar/opacity. X→`restTimers.delete(setId)`, show toggle btn. Per-ex default secs from `prefsByExercise` (load in `boot()`). Smooth anim: CSS `transition:width 50ms linear`. Mobile: `@media(max-width:600px){.timerbar-controls{display:none;}}`.

**Edge cases**: Multi-sets/ex: independent timers. Past workout edit: no ticks. Inspect next: `api/exercise_prefs.php` (extend `prefs_json` w/`default_timer_secs` if per-ex memory needed). Test: add set→check→bar shrinks→pause→end vibrates→next set highlights.

### Q: better now, we still need to make sure that we can change how long the timer is, instead of rainbow make it a green bar and make it thicker (not too thick though), also until an exercise has been checked it should nin the muscle heat map, which means when checking and unchecking we need to call an update in the muscle heatmap, give me the files in the same files list format needed to chagne that alongside instructions to an AI that is going to be doing this
**Core files to change:**
- `lib/workout_ui.js` (add per-set timer duration input in `renderWorkoutEditor()` / `.setTimerRow`; checkbox `doneChk` onChange→filter `viewingSets` to `completed=1` only before `onEditorSetsChanged(sets)` for workout heat; `tickRestTimers(now)` uses per-set `totalSec`; `startTimerForSet(setId, secsFromInput)` reads input val or fallback `prefs.timer_secs`; wire input change→`restartTimerWithNewSecs()`; `updateSetTimerUIForRow()` reads input for display)
- `style.css` (`.timerbar`: `height:6px;background:var(--accent);` (solid green), `.timerbar.paused{opacity:0.5;}`, `.timerbar-controls input[type=number]{width:50px;font-size:12px;padding:4px;}`)

**Supporting files (read for context):**
- `main.js` (`workoutUI.onEditorSetsChanged(filteredCompletedSets)`→`heat.setWorkoutSets()` auto-rebuilds/paints in `animate()`; ensure `rebuildHeatAndPaint()` filters if needed)
- `lib/heat_engine.js` (`setWorkoutSets(sets)` uses all passed sets; doc that caller must filter `completed=1`)

**New files needed:**
- None (extend existing per-set `restTimers` Map→`{..., totalSec, inputEl}`; client-only)

```python
FILES = [
    "lib/workout_ui.js",
    "style.css",
    "main.js",
    "lib/heat_engine.js"
]
```

**Implementation Guide (Phased, ~1-2h):**
**Phase 1: Per-set duration input + solid/thicker green bar (45m)**: In `renderWorkoutEditor()`, `.setTimerRow`→add `<input class="timerSecsInput" type=number min=0 max=3600 step=5 value="${prefs.timer_secs}" title="Rest seconds"/>` before controls. CSS: `.timerbar{height:6px;background:var(--accent);transition:width 0.1s ease;}` (remove gradient). `startTimerForSet(setId)`→`secs = parseInt(timerSecsInput.value || prefs.timer_secs)`. Wire input `change`→`restartTimerWithNewSecs(setId)` (stop→start w/new secs).

**Phase 2: Checkbox→filter completed for heat (30m)**: `doneChk` onChange→`const completedSets = viewingSets.filter(s=>s.completed===1); onEditorSetsChanged(completedSets);` (workout heat ignores incomplete). Uncheck→same filter. `heat_engine.js`: doc `setWorkoutSets(only use completed sets)`. Test: add set→heat blank→check→heat appears→uncheck→heat gone.

**Phase 3: Polish/timer tick (15m)**: `tickRestTimers()`→if `secsInput.value` changed since last, `restartTimerWithNewSecs()`. `updateSetTimerUIForRow()`→show input val in `.setTimerText` if idle. Mobile: `@media(max-width:480px){.timerSecsInput{display:none;}}` (use prefs only). Edge: past workout edit→no ticks/inputs. Inspect: `api/exercise_prefs.php` (fallback secs). Test: change secs→check→bar shrinks w/new duration→pause→change secs→resume→new duration.

### Q: It still requires me to go to overall musclmap and back into the workout musclmeap for it to actually update, it needs to happen every time I check or uncheck the checkmark or when I change the sets or when Ior when I change how much weight is in it, you get it
**Core files to change (immediate workout heat updates on checkbox/reps/load changes):**
- `lib/workout_ui.js` (`pushPendingOrLive(patch)`→after `onEditorSetsChanged(filteredSets)`, add `mainRebuildHeatAndPaint()` callback; `doneChk`/`repsInput`/`loadInput` onChange→immediate filter+emit; `tickSetTimers(now)`→if workout mode, `rebuildHeatAndPaint()`)
- `main.js` (expose `rebuildHeatAndPaint` as global/export or callback to workoutUI; `onEditorSetsChanged`→`await rebuildHeatAndPaint()`; `animate()`→`heat.tick(now)`→immediate paint if workout mode changed recently)

**Supporting files (read for context):**
- `lib/heat_engine.js` (`setWorkoutSets(sets)`→if workout mode, `rebuildMuscleFromLogs(Date.now())` mini-rebuild; `rebuildNow()` already filters via caller)
- `lib/renderer3d.js` (`applyHeatToAllMeshes(state)` paints immediately)

**New files needed:**
- None (add `rebuildHeatAndPaint` callback to workoutUI init)

```python
FILES = [
    "lib/workout_ui.js",
    "main.js",
    "lib/heat_engine.js",
    "lib/renderer3d.js"
]
```

**Implementation Guide (Phased, ~45m):**
**Phase 1: Immediate rebuild on changes (20m)**: `main.js`→`workoutUI` init: pass `onSetsChanged: async(sets)=>{ heat.setWorkoutSets(sets); await rebuildHeatAndPaint(); }`. `lib/workout_ui.js`→`onEditorSetsChanged`→`this.onSetsChanged?.(getHeatRelevantSets())`. Test: live workout→add set→check→heat updates instantly (no 2s/ mode-switch). Uncheck→heat gone.

**Phase 2: Workout mode auto-rebuild in tick (15m)**: `lib/heat_engine.js`→`setWorkoutSets(sets)`: `if(this.getMode()==="workout"){ this.state.logs=setsToHeatLogs(sets); this.rebuildMuscleFromLogs(Date.now()); }`. `main.js` animate→`const st=heat.tick(now); renderer3d.applyHeatToAllMeshes(st,now);` (remove 2s throttle for workout mode or make it 500ms).

**Phase 3: Polish/edge (10m)**: `lib/workout_ui.js`→`tickSetTimers(now)`→`if(!viewingWorkoutId && heat.getMode()==="workout") mainRebuildHeatAndPaint();`. Past edit: changes→filter completed→emit→rebuild (no live ticks). Mobile: `@media(max-width:480px){.setTimerActions{opacity:0.7;}}` (tap to expand). Test: reps/load change→stim recalc→heat shift immediate; switch modes→seamless.

**Edge cases**: Empty workout→workout heat blank (doc in manual). Pending edits (past)→local filter only (server on save). Inspect next: `main.js` animate throttle (if lag). Test: live→check3→reps++→uncheck1→heat live-updates each step.
