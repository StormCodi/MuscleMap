# MuscleMap Developer Manual

## Overview

MuscleMap is a web-based fitness app using Three.js and Z-Anatomy GLB models to visualize muscle heat maps from workout logs. Key features: live workout CRUD in `index.html` via `lib/workout_ui.js`, 36h decay heat in `lib/heat_engine.js`/`lib/recovery.js`, muscle sensitivity (`api/muscle_sensitivity.php`), exercise prefs/timers (`api/exercise_prefs.php`/`lib/set_timers.js`), AI exercise suggestions (`ai_chat.html`→`api/ai_chat.php`→xAI→`api/add_exercises.php`), admin manual generation (`admin_manual.php`→`api/admin_manual_trigger.php`→`grok_manual_dump.php` with files/DB). Per-user MySQL via `api/db.php` (PDO/session/auth).

```
UI (index.html/ai_chat.html/login.html/admin_manual.php)
  ↓ JS (main.js/lib/*.js/ai_chat.js)
  ↓ fetch()/apiJson()
PHP API (api/*.php) ──┬→ DB (MySQL: users/workouts/workout_sets/exercises/exercise_prefs/muscle_sensitivity/workout_logs(legacy)/exercises_backup_*)
                      ↓ (ai_chat.php/ai_upload.php)
                      → xAI Grok
  ↑ json_ok()/json_err() (api/db.php)
  ↑ JS render (heat/Three.js/recs)
```

## 1) Directory/Module Map

- **Root**: `index.html` (main app w/ 3D/heat/workout), `ai_chat.html`/`ai_chat.css`/`ai_chat.js` (AI chat w/ uploads/preview), `login.html` (auth), `admin_manual.php` (admin UI/chat/console/manual), `style.css`.
- **lib/**: JS utils/modules.
  - `api.js`: Endpoints/`apiJson()` (fetch w/ 401→login).
  - `exercises.js`: Cache `exercises_list.php`/`get_exercises.php`.
  - `heat_engine.js`: `rebuildNow()`/`tick()`/modes (overall/workout)/sensitivity.
  - `muscleMap.js`: `classifyMeshName()`/`GROUPS` (muscle mapping).
  - `recovery.js`: `computeHeat()`/`applyStimulus()`/`isNeglected()`.
  - `recs.js`: `generateRecs()`.
  - `renderer3d.js`: `createRenderer3D()` (scene/pick/heat).
  - `set_timers.js`: `createSetTimerManager()` (per-set timers).
  - `utils.js`: `parseSqlDateTime`/`fmtMMSS`/`clampInt`.
  - `workout_*.js`: `workout_ui.js` (orchestrates editor/history/timers), `workout_editor.js`, `workout_history.js`.
- **api/**: Req `db.php` (PDO/session/`json_ok`/`json_err`/`require_user_id`).
  - `auth/*.php`: login/register/logout.
  - `workout/*.php`: CRUD (`_lib.php`: autoclose/helpers/`workout_summary`).
  - `ai_chat.php`: xAI schema/normalize.
  - `add_exercises.php`: Insert/upsert exercises.
  - `ai_upload.php`: Img `/uploads/ai_tmp/u{uid}/` (TTL24h).
  - `exercise_prefs.php`/`muscle_sensitivity.php`: Maps JSON.
  - `exercises_list.php`/`get_exercises.php`: List active.
  - Admin: `admin_manual_trigger.php` (async run/tail), `manual_sql_query.php` (SELECT).
- **Admin**: `grok_manual_dump.php` (files/DB→xAI/manual/Q&A).
- **Other**: `uploads/` (TTL), `logs/` (daily errors), `assets/models/` (GLB).

## 2) Data Model (tables + key fields)

From DB dump:

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `exercise_prefs` | Per-ex prefs | `user_id`(PK/FK),`exercise_key`(PK),`prefs_json` (e.g. `{"timer_enabled":true,"timer_secs":60}`),`updated_at`. |
| `exercises` | Catalog | `id`(PK/AI),`user_id`(FK),`exercise_key`(uniq/user),`name`,`weights_json` (e.g. `{"chest":0.9}`),`source`(`user`/`ai`),`is_active`,timestamps. |
| `exercises_backup_*`/old/fix | Backups | As `exercises`. |
| `muscle_sensitivity` | Sens | `user_id`(PK),`group_id`(PK/uniq),`sensitivity`(float 0.05-1.5),`updated_at`. |
| `users` | Accts | `id`(PK/AI),`email`(uniq),`password_hash`,timestamps. |
| `workout_logs` (legacy) | Flat | `id`(PK/AI),`user_id`,`workout_date`,`exercise_id`/`name`,`sets`/`reps`/`load_lbs`/`stimulus`,`muscles_json`,`created_at`. |
| `workout_sets` | Sets | `id`(PK/AI),`workout_id`(FK),`user_id`,`exercise_id`/`name`,`reps`/`load_lbs`/`stimulus`/`completed`,`muscles_json`,timestamps. |
| `workouts` | Sessions | `id`(PK/AI),`user_id`(FK),`started_at`/`ended_at`/`auto_closed`,timestamps. |

Invariants: Per-user FK CASCADE, snake_case JSON 0-1, `stimulus` computed.

## 3) API Endpoints (path, method, request JSON, response JSON, errors)

Req `db.php`; 401→login.

| Path | Method | Req JSON | Res JSON | Errors |
|------|--------|----------|----------|--------|
| `/api/auth/login.php` | POST | `{email,password}` | `{ok:true,user_id:int}` | `bad_email`/`bad_password`/`invalid_credentials`(401). |
| `/api/auth/register.php` | POST | `{email,password}` | `{ok:true,user_id:int}` | `bad_email`/`bad_password`/`email_taken`(409)/`hash_fail`. |
| `/api/auth/logout.php` | POST | - | `{ok:true}` | - |
| `/api/workout/status.php` | GET | - | `{ok:true,active:{id,started_at,...summary:{sets_count,...}}}`/null | 401. |
| `/api/workout/start.php` | POST/GET | - | `{ok:true,workout:{id,...}}` | - |
| `/api/workout/end.php` | POST/GET | - | `{ok:true,ended:bool,...}` | - |
| `/api/workout/get_current.php` | GET | - | `{ok:true,active:Workout,sets:[Set]}` | - |
| `/api/workout/add_set.php` | POST | `{exercise_id,name,reps,load_lbs?,stimulus,completed?,muscles?}` | `{ok:true,set:Set,summary}` | No active(409). |
| `/api/workout/update_set.php` | POST | `{set_id,reps?,load_lbs?,stimulus?,completed?,muscles?}` | `{ok:true,updated:bool,summary}` | `bad_set_id`/no fields/404. |
| `/api/workout/delete_set.php` | POST | `{set_id}` | `{ok:true,deleted:bool,summary}` | 404. |
| `/api/workout/delete_sets_for_exercise.php` | POST | `{exercise_id}` | `{ok:true,deleted:int,...}` | No active(409). |
| `/api/workout/get_workout.php?id={id}` | GET/POST | `{id}` | `{ok:true,workout:Workout,sets:[Set]}` | 404. |
| `/api/workout/list_workouts.php?page=&per=` | GET | Query | `{ok:true,page,pages,...workouts[]}` | - |
| `/api/workout/get_last_sets_for_exercise.php?exercise_id=&last_completed_only?` | GET | Query | `{ok:true,workout_id?,sets:[],last_completed_set?}` | - |
| `/api/exercises_list.php`/`get_exercises.php` | GET | - | `{ok:true,exercises:[{id,name,w:{}}]}` | - |
| `/api/exercise_prefs.php` | GET/POST | `{exercise_key?,prefs?,map?}` | GET:`{map:{ex_key:{timer_enabled?,timer_secs}}}` POST:`{saved:int}` | `bad_json`/`missing_*`. |
| `/api/muscle_sensitivity.php` | GET/POST | `{group_id?,sensitivity?,map?}` | GET:`{map:{group:float}}` POST:`{saved:int}` | `missing_*`. |
| `/api/ai_upload.php` | POST | Multipart `image` | `{ok:true,token,mime,url}` | `missing_image`/too_large(413)/bad_type(415). |
| `/api/ai_chat.php` | POST | `{history?,text?,image_tokens[]}` | `{ok:true,assistant:{text,reply:{type,...},raw_json},history}` | `missing_input`/502. |
| `/api/add_exercises.php` | POST | `{id,name,w:{},source?}` | `{ok:true}` | `bad_id`/`name`/`weights`/`empty_weights`. |
| `/api/admin_manual_trigger.php` | POST | Payload | `{ok:true,exit_code,...tail/final_output/script_json/runner}` | 403. |
| `/api/manual_sql_query.php` | POST | `{query}` | `{ok:true,sql:str,rows:[],count:int}` | Admin(403)/`select_only`/`no_multi`/blocked(400)/500. |

`json_err()` logs/HTTP.

## 4) Frontend Flow (pages, JS modules, how calls happen)

- **index.html** (`main.js`): `createRenderer3D`(GLB/pick/heat via `classifyMeshName`/`computeHeat`), `createHeatEngine`(logs→heat/`rebuildNow`), `createWorkoutUI`(poll status/add_set→heat). `animate()`: tick/decay/paint/recs.
- **ai_chat.html** (`ai_chat.js`): Upload(`ai_upload.php`)→chat(`ai_chat.php`)→accept(`add_exercises.php`)→`index.html?new_ex=key`(preselect).
- **login.html**: Auth→session→index.
- **admin_manual.php**: UI/chat→`admin_manual_trigger.php`(async poll tail/clear console)→`grok_manual_dump.php`.
- Orchestrate: `main.js`; workout: `workout_ui.js`(editor/history/timers); heat: `heat_engine.js`.

## 5) AI Intake / schema explanation (if present)

`api/ai_chat.php`: xAI prompt→JSON.

Schema:
```
{"type":"error|question|exists|propose_add|propose_add_many","text":str,"choices"?:[str],"id"?:str,"name"?:str,"proposal"?:{exercise_key:str,name:str,weights:{group_id:float,...},confidence:float},"proposals"?:[Proposal]}
```
Loads active ex, validates snake_case/0-1/match. Images: `/uploads/ai_tmp/u{uid}/{token}`→data:URL(9MB). JS→PHP→xAI→cards→add.

No MMJ schema.

## 6) How to Extend

- **Exercise**: AI/DB `exercises` insert/`add_exercises.php`.
- **Muscle**: `muscleMap.js` `GROUPS`/classify; sens `muscle_sensitivity.php`; AI list `ai_chat.php`.
- **Endpoint**: `api/new.php`+`db.php`/ `api.js`.
- **Workout**: `workout_ui.js`/editor (`add_set.php` fields)/`set_timers.js`.
- **Heat**: `heat_engine.js`/`recovery.js`.

## 7) Troubleshooting (common errors, logs, permissions, DB)

- **401**: Session→login (`db.php` `current_user_id()`).
- **500/JSON**: `/logs/errors-*.log` (`db.php`). DB `db_unavailable`.
- **No heat**: `status.php`/autoclose 5h (`_lib.php`).
- **Model**: `assets/models/body.glb`. Pick `muscleMap.js`.
- **AI**: Key `/etc/...`/TTL24h. Weights val.
- **Admin**: `user_id=1`; `grok_manual_dump.php` scans/SQL.
- **DB**: Per-user CASCADE; backups `*backup_*`.

## 8) Q&A

_Questions and answers are appended here over time._

## Q&A

_Questions and answers are appended here over time._

### Q: how to change the code so that the model can run enrichment queries in the Q&A chat, add a copy console button, make it so that it clearly shows the total used in the last query AND since the chat/console was cleared which is also to actually be one button now (two different number sets) it also should accompany how much that query cost using xAI data from the model selected, give me a python list FILES = [] that includes all the files that need to be changed for this only use local storage and explain what each file needs to do for this
**Supported by files.** `admin_manual.php` already uses localStorage for chat (`mm_admin_chat`), polls `api/admin_manual_trigger.php` for live console (`#out_pre`), runs Q&A via `grok_manual_dump.php --question=... --use-existing-manual=1` (async via trigger). `grok_manual_dump.php` has xAI `usage` capture (prompt/completion/total tokens per round), JSON mode (`script_json`), manual SQL enrichment stub (not in Q&A). No pricing/cost logic or copy/clear UI. No `api/manual_sql_query.php` (not found; would need new for safe SELECT).

To implement (minimal changes; use existing polling/JSON/localStorage):

#### Python list of FILES to change:
```python
FILES = [
    "admin_manual.php",           # UI/JS: Add copy/clear btn (clear chat+console+localStorage totals), display last/cumulative tokens+cost (from trigger response), extend localStorage for totals/since_clear, poll enhancements.
    "api/admin_manual_trigger.php", # Enhance status JSON: Parse/include `script_json.usage` (last/cumulative tokens), add model pricing map → cost USD (e.g., grok-4 $5/M input/$15/M output), pass to response.
    "grok_manual_dump.php"        # Q&A (--question): Add `--allow-sql=1` support (like manual gen: AI proposes SELECT → exec via new endpoint → append results), capture/log usage per Q&A call, include in `script_json` (totals since script start).
]
```
**No new files needed** (add SQL endpoint logic to `grok_manual_dump.php` or reuse trigger; use existing polling/JSON).

#### Per-file changes:
1. **`admin_manual.php`** (UI/JS orchestrator):
   - **Console**: Add `<button id="copyConsole">Copy</button>` + `<button id="clearAll">Clear All</button>` near `#out_pre`. `clearAll.onclick`: `localStorage.removeItem("mm_admin_chat"); localStorage.removeItem("mm_totals"); CHAT=[]; chatRender([]); setOut(""); totals={last:0,cum:0,cost:0}; updateTotalsUI();`. `copyConsole.onclick`: `navigator.clipboard.writeText($("out_pre").textContent)`.
   - **Totals UI**: Add `<div id="totalsUI" class="totals-row">Last: <span id="lastTokens">-</span> toks | Since clear: <span id="cumTokens">-</span> | $<span id="cumCost">0</span></div>` below `#status`. Poll response → `updateTotalsUI(data.script_json?.usage?.total_tokens || 0, storedCum + newTotal, computeCost(model, usage))`.
   - **LocalStorage**: On poll success: `let totals=JSON.parse(localStorage.getItem("mm_totals")||"{}"); totals.last = data.script_json?.usage?.total_tokens||0; totals.cum += totals.last; totals.model = model; localStorage.setItem("mm_totals",JSON.stringify(totals));`.
   - **Clear**: Reset `totals.cum=0` in localStorage on clear.
   - **Cost**: JS func `computeCost(model,usage){ const prices={grok4:{in:0.005,out:0.015}}; return (usage.prompt*prices[model].in + usage.completion*prices[model].out)/1e6; }` (hardcode xAI rates).
   - **SQL checkbox**: Add `<input id="allow_sql" type="checkbox"/> allow AI SELECT` → `payload.allow_sql=1`.

2. **`api/admin_manual_trigger.php`** (async runner):
   - **Status JSON**: From `script_json` (grok_dump output): Add `usage: {last_tokens: script_json.usage?.total_tokens, cum_tokens: ? (pass from script), cost_usd: compute(model,usage)}`. Hardcode pricing: `$prices=['grok-4-1-fast-reasoning'=>['in'=>5,'out'=>15]]; $cost=($usage['prompt_tokens']*$prices[$model]['in']/1e6 + $usage['completion_tokens']*$prices[$model]['out']/1e6);`.
   - **Tail**: Append usage/cost to `tail` or new `status` field.
   - **Payload**: Forward `allow_sql` to cmdParts (`--allow-sql=1`).

3. **`grok_manual_dump.php`** (xAI core):
   - **Q&A (--question)**: Mirror manual gen: If `--allow-sql=1`, first round: AI prompt "Propose 0-N SELECT queries (LIMIT 50, safe only) or answer directly. JSON: {'queries':['SELECT...']}". Parse/exec (new safe_exec_sql($pdo,$queries)), append "===== AI SQL: ... =====" + results to context, then answer Q. Limit 3 queries/Q&A.
   - **Usage**: Already sums `$usageTotals` across rounds; for Q&A: `$script_json['usage'] = $usageTotals; $script_json['sql_queries'] = $executed||[];`.
   - **Cum since clear**: Not tracked (per-run); UI handles via localStorage.
   - **JSON output**: Ensure `{"ok":true,"output":markdown,"usage":{...},"sql_executed":?...}`.

**Next inspect**: Test `admin_manual.php` poll response (`console.log(data)`), add `--allow-sql=1` to chat payload, verify `grok_manual_dump.php` usage in `script_json`. Pricing from xAI docs (update map). LocalStorage keys: `mm_admin_chat`, `mm_totals:{model,last_tokens,cum_tokens,cum_cost}`. No DB changes (transient).
