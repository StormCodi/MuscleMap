# MuscleMap Developer Manual

MuscleMap is a single-page web application for workout tracking and muscle recovery visualization using a 3D anatomical model. Features include real-time muscle "heat" maps based on logged workouts, workout session management, exercise database with muscle weights, and an AI chat interface (powered by xAI Grok) for adding new exercises via text or image descriptions. All data is stored in MySQL for a single user (GLOBAL_USER_ID=0). Frontend uses Three.js for 3D rendering; backend PHP APIs handle DB/AI interactions. No authentication; assumes single-user deployment.

## High-Level Architecture

```
+----------------+     +----------------+     +----------------+
|   Frontend     |<--->|    PHP APIs    |<--->|    MySQL DB    |
| (HTML/JS/CSS)  |     | (api/*.php)    |     | (exercises,    |
| - index.html   |     | - db.php       |     |  workouts,     |
| - ai_chat.html |     | - ai_chat.php  |     |  workout_sets) |
| - main.js      |     +----------------+     +----------------+
| - ai_chat.js   |            |                       ^
+----------------+            v                       |
          |             +----------+                 |
          |             |   xAI    |                 |
          v             |  (Grok)  |-----------------+
     Three.js 3D       +----------+
     (body.glb model)
```

- **UI -> JS**: Event handlers in main.js/ai_chat.js trigger fetch() to APIs.
- **JS -> PHP**: JSON payloads to api/*.php; images via multipart to ai_upload.php.
- **PHP -> DB**: PDO queries via api/db.php (GLOBAL_USER_ID=0).
- **PHP -> AI**: ai_chat.php sends multimodal prompt (text+images) to x.ai/v1/chat/completions (grok-4-0709).
- **DB -> UI**: JSON responses rebuild 3D heatmaps, lists, editors.

## 1) Directory/Module Map

- **Root**:
  - `index.html`: Main app page (3D viewer, workout editor, history).
  - `ai_chat.html`: AI chat page for exercise proposals.
  - `ai_chat.css`, `style.css`: UI styles (dark theme, responsive).
  - `main.js`: Core app logic (Three.js model, workout APIs, heatmaps).
  - `ai_chat.js`: AI chat UI (image upload, 3D preview, proposals).

- **lib/**:
  - `exercises.js`: Caches exercises from api/exercises_list.php (getAllExercisesCached()).
  - `muscleMap.js`: classifyMeshName() maps GLB mesh names to muscle groups (GROUPS array).
  - `recovery.js`: computeHeat(), applyStimulus() for muscle load decay/heat.
  - `recs.js`: generateRecs() based on heat/neglect.
  - `storage.js`: LocalStorage state (loadState(), saveState() — legacy, not used in new workout system).

- **api/**:
  - `db.php`: PDO connection (musclemap DB, GLOBAL_USER_ID=0).
  - AI: `ai_chat.php` (chat), `ai_upload.php` (images), `add_exercises.php` (save proposals).
  - Exercises: `exercises_list.php`, `get_exercises.php` (legacy?).
  - Legacy logs: `get_logs.php`, `log_workout.php`, `get_muscle_state.php`.
  - Workouts: `workout/_lib.php` (helpers), plus start.php, end.php, status.php, get_current.php, add_set.php, update_set.php, delete_set.php, get_workout.php, list_workouts.php, migrate_from_legacy.php.
  - Utils: `state_reset.php` (disabled), `token_audit.php`, `grok_manual_dump.php` (dev tools).

- **assets/models/**: body.glb (3D model, fallback draco).
- **vendor/three/**: Three.js modules.

No node_modules/build/dist; static deployment.

## 2) Data Model

Tables inferred from PHP queries (no full DB dump provided; only code references). All use user_id (GLOBAL_USER_ID=0). JSON fields store {muscle_group_id: weight 0.0-1.0}.

| Table          | Key Fields |
|----------------|------------|
| **exercises** | `exercise_key` (id, snake_case unique w/ user_id), `name` (str<=128), `weights_json` (JSON {group:0-1}), `source` (user/ai), `is_active` (bool), `updated_at` (timestamp). Upsert on (user_id, exercise_key). |
| **workouts**  | `id` (PK), `user_id`, `started_at`/`ended_at` (timestamps; NULL=active), `auto_closed` (bool), `created_at`/`updated_at`. Autoclose after 5h (api/workout/_lib.php). |
| **workout_sets** | `id` (PK), `workout_id` (FK), `user_id`, `exercise_id`/`exercise_name` (str), `reps` (int1-1000), `load_lbs` (float|null), `stimulus` (float0-5), `muscles_json` (JSON {group:float>0}), `created_at`/`updated_at`. |
| **workout_logs** (legacy) | `id`, `workout_date` (date), `exercise_id`/`exercise_name`, `sets`/`reps`, `load_lbs`, `stimulus`, `created_at`, `muscles_json`. Migrated via migrate_from_legacy.php. |
| **muscle_state** | `muscle_group` (id), `load_value` (0-1), `last_trained_at`/`last_ping_at` (timestamps). |

Invariants: weights_json/muscles_json validated (snake_case keys, 0-1 floats, allowed groups). No sessions/messages/images tables found.

## 3) API Endpoints

All return JSON {ok:bool, error?:str, ...}. Errors: 400 bad_json/bad_id/etc., 500 server_error/db_error, 502 xai_*.

| Path | Method | Request | Response | Notes/Errors |
|------|--------|---------|----------|--------------|
| `/api/ai_chat.php` | POST | `{history:[{role,text}], text:str, image_tokens:[hex32]}` | `{ok, assistant:{text,reply:{type,proposal?,proposals?,...},raw_json}}` | Calls xAI; validates proposals vs DB. Errors: missing_input, db_error, xai_*. |
| `/api/add_exercises.php` | POST | `{id:str, name:str, w:{group:0-1}, source?:"ai"}` | `{ok}` | Upserts exercises. Errors: bad_id/bad_name/bad_weights. |
| `/api/ai_upload.php` | POST | Multipart `image` (jpg/png/webp<4.5MB) | `{ok, token:hex32, url:str}` | Stores /uploads/ai_tmp/{token}.ext (TTL 24h cleanup). Errors: too_large, bad_image_type. |
| `/api/exercises_list.php` | GET | - | `{ok, exercises:[{id,name,w:{group:0-1}}]}` | Active exercises for user. |
| `/api/workout/start.php` | POST/GET | - | `{ok, workout:{id,started_at,...}}` | Creates or returns active. |
| `/api/workout/end.php` | POST/GET | - | `{ok, ended:bool, summary:{sets_count,...}}` | Sets ended_at. |
| `/api/workout/status.php` | GET | - | `{ok, active?:{id,...}}` | Autoclose check. |
| `/api/workout/get_current.php` | GET | - | `{ok, active?, sets:[{id,exercise_id,reps,load_lbs,stimulus,muscles,...}]}` | Current workout sets. |
| `/api/workout/add_set.php` | POST | `{exercise_id:str, exercise_name:str, reps:int, load_lbs?:float|null, stimulus:float, muscles:{group:float}}` | `{ok, set:{}, summary:{}}` | Adds set to active workout. |
| `/api/workout/update_set.php` | POST | `{set_id:int, reps?:int, load_lbs?:float|null, stimulus?:float, muscles?:{}}` | `{ok, updated:bool, summary:{}}` | Patches set. |
| `/api/workout/delete_set.php` | POST | `{set_id:int}` | `{ok, deleted:bool, summary:{}}` | Deletes set. |
| `/api/workout/get_workout.php?id=int` | GET/POST | `{id:int}` | `{ok, workout:{}, sets:[]}` | Full workout. |
| `/api/workout/list_workouts.php?page=int&per=int` | GET | - | `{ok, page, pages, workouts:[{id,summary:...}]}` | Paginated list. |

Legacy: get_logs.php (workout_logs), log_workout.php, get_exercises.php (exercises_custom — not found in new code).

## 4) Frontend Flow

- **index.html + main.js**:
  1. Boot: loadGLB() (body.glb), renderExerciseOptions() (api/exercises_list.php), refreshStatus() -> loadCurrentWorkoutSets() (get_current.php).
  2. Render loop: tickWorkoutTimer(), rebuildMuscleFromLogs() -> applyHeatToAllMeshes().
  3. Muscle pick: raycaster on pointerup -> setSelected() (classifyMeshName()).
  4. Workout: startWorkout() (start.php), addExerciseAsOneSet() (add_set.php w/ default reps=10/stim), edit live/past (update_set.php/delete_set.php).
  5. History: refreshHistory() (list_workouts.php + get_workout.php), viewWorkout() switches to editor.
  6. Heat: toggle heatMode ("overall" caches 40 recent workouts; "workout" uses viewingSets/active sets).

- **ai_chat.html + ai_chat.js**:
  1. Load history from LS (musclemap_ai_chat_v2).
  2. Image pick: onPickImages() -> uploadOneImage() (ai_upload.php) -> tokens/urls.
  3. Send: composer submit -> sendToServer() (ai_chat.php) -> renderReplyCard() (proposals).
  4. Proposal: acceptProposal() (add_exercises.php), preview highlights 3D (applyPreviewWeights() via classifyMeshName()).
  5. 3D: loadPreviewGLB() (separate body.glb instance).

LocalStorage: musclemap.v1 (legacy state), musclemap_ai_chat_v2 (chat history).

## 5) AI Intake / MMJ schema explanation

**AI Flow** (ai_chat.php + ai_chat.js):
- Upload images -> tokens (ai_upload.php, /uploads/ai_tmp/).
- POST history/text/tokens -> PHP resolves data:URLs, loads exercises, builds system prompt w/ schema/existing exercises/allowed groups.
- xAI grok-4-0709 (temp=0.2, max=1400) -> parse JSON reply.
- **MMJ Schema** (muscles_json/weights_json): `{ "abs_upper": 0.85, "chest": 0.42, ... }` (snake_case keys, 0-1 floats, <=6 groups).
- **Reply Types**:
  | type | Fields |
  |------|--------|
  | propose_add | proposal:{exercise_key, name, weights:{}, confidence:0-1} |
  | propose_add_many | proposals:[] (as above) |
  | exists | id:str, name:str |
  | question | text:str, choices?:[] |
  | error | text:str |
- Server normalizes (normalizeId/Name/weightsNormalize), checks exactMatchExercise vs DB, enforces allowedIds (abs_upper,chest,... — full list in ai_chat.php).
- JS: renderProposal() -> Accept (add_exercises.php), Preview (applyPreviewWeights()).

## 6) How to Extend

- **New Exercise**: POST to add_exercises.php {id:"snake_case", name:"Pushup", w:{chest:0.9,...}, source:"ai"}. Or via AI chat.
- **New Muscle Group**: 1) lib/muscleMap.js: Add to GROUPS {id:"new_group", label:"New", tokens:["mesh_token"]}. 2) ai_chat.php: Add to $allowedIds. 3) Update 3D classifyMeshName(). Bust cache: bustExercisesCache().
- **New Endpoint**: Add api/new.php (use _lib.php helpers: json_ok(), read_json_body()). Ex: require db.php, PDO prepare/execute.
- **New AI Reply Type**: Extend system prompt schema in ai_chat.php; handle in normProposal()/$reply normalization.
- **Migration**: api/workout/migrate_from_legacy.php --uid=0 --truncate=1 (CLI).
- **Model**: Drop body.glb in assets/models/.

## 7) Troubleshooting

| Error | Where to Look |
|-------|---------------|
| bad_json/invalid_json | JS payload (ai_chat.js sendToServer()). |
| db_error/server_error | api/db.php creds; PDO exceptions (GLOBAL_USER_ID=0). |
| xai_http_error/missing_api_key | /etc/musclemap/xai_api_key; curl in ai_chat.php. |
| No active workout (409) | api/workout/_lib.php autoclose_if_needed() (5h timeout). |
| Upload fail (too_large/bad_type) | ai_upload.php: <4.5MB jpg/png/webp. |
| Model not loading | assets/models/body.glb (fallback draco); classifyMeshName() ignores. |
| Heat not updating | main.js rebuildHeatNow() (overallCache.maxWorkouts=40); lib/recovery.js halfLifeHrs=36. |
| AI no proposals | Check allowedIds match lib/muscleMap.js GROUPS; exactMatchExercise(). |
| Pending edits lost | viewingWorkoutId; pending.dirty in main.js. |

Logs: PHP error_reporting(E_ALL) in log_workout.php etc. Refresh: Ctrl+F5 (no-cache fetches).

## 8) Q&A

_Questions and answers appended over time._

## Q&A

_Questions and answers are appended here over time._

### Q: what would need to be done to migrate to a commercial, multi-user system

The codebase is explicitly designed for single-user use (GLOBAL_USER_ID=0 hardcoded in `api/db.php`; manual notes "No authentication; assumes single-user deployment"). DB schema supports multi-user via `user_id` FKs in `exercises`, `workouts`, `workout_sets`, `workout_logs` (legacy), `muscle_state`, but no `users` table, auth, or per-user isolation found. No sessions/messages/images tables. Here's a migration outline based on code patterns:

#### 1. **Database Changes**
   - Add `users` table (not present): `id` (PK), `email` (unique), `created_at`, `xai_api_key?` (opt for per-user AI billing).
   - Enforce `user_id` indexes/UNIQUEs (e.g., `exercises` UNIQUE(user_id, exercise_key) implied in `add_exercises.php`).
   - Per-user uploads: mkdir `/uploads/{user_id}/ai_tmp/` in `ai_upload.php`; update token paths.
   - Migrate data: Run per-user version of `api/workout/migrate_from_legacy.php` with `--uid=N`.

#### 2. **Authentication**
   - Add login/register endpoints (`api/auth.php`): POST `{email, password}` → JWT/session cookie.
   - Middleware in all `api/*.php`: Validate `Authorization: Bearer <jwt>` or session; extract `user_id`; replace `GLOBAL_USER_ID`.
   - Use `api/_lib.php` helpers (e.g., `user_id()` → from auth).
   - Frontend: Add login page/form in `index.html`/`ai_chat.html`; store JWT in memory (not LS); pass to `fetch()` headers.

#### 3. **API Adjustments**
   - All endpoints (e.g., `ai_chat.php`, `workout/*.php`, `exercises_list.php`): Filter `WHERE user_id = :uid`; `:uid` from auth.
   - AI costs: Per-user `xai_api_key` from `users` (read via `/etc/musclemap/{user_id}_xai_api_key` or DB); rate-limit in `ai_chat.php`.
   - Errors: Add `unauthorized` (401) in `bad()` helpers.
   - Pagination (`list_workouts.php`): User-specific already via `user_id`.

#### 4. **Frontend Changes**
   - `main.js`/`ai_chat.js`: Add auth state; redirect unauth to login; `apiJson()` → add `headers: {Authorization: Bearer ${token}}`.
   - LocalStorage: Prefix keys (`musclemap_ai_chat_v2_{user_id}`); clear on logout.
   - UI: User profile/logout in HUD; per-user history/exercises.

#### 5. **Scaling/Commercial**
   - Shared resources: `/uploads/ai_tmp/` TTL cleanup → per-user dirs/cron.
   - Billing: Track AI calls (`workout_sets`?); integrate Stripe.
   - Deployment: Env vars for DB creds (`api/db.php`); HTTPS enforced.
   - Invariants: Validate `user_id` ownership (e.g., `workout_sets` WHERE workout_id IN (SELECT id FROM workouts WHERE user_id=?)).

#### Edge Cases
   - Legacy: `get_logs.php`/`log_workout.php` → deprecate/migrate.
   - No cross-user data leak (already `user_id`-scoped).
   - Test: Seed multi-user DB; verify isolation.

Not fully supported (no auth/users schema in files/DB refs). Next: Dump full DB schema (`SHOW TABLES; DESCRIBE *;`) via `grok_manual_dump.php --db=1`; add `users` + auth lib (e.g., Firebase Auth). Prototype: Fork `api/db.php` → `get_user_id_from_jwt($token)`.

### Q: how would you improve the workout logging system?
The current system (api/workout/*.php, main.js) is solid for basic per-set logging (individual reps/load/stimulus/muscles_json per workout_sets row, workouts as containers with 5h autoclose in _lib.php::autoclose_if_needed()). It supports live editing, past workout edits (update_set.php/delete_set.php), migration from legacy workout_logs (migrate_from_legacy.php), and pagination (list_workouts.php). Heat/recommendations derive from it well (rebuildMuscleFromLogs() in main.js). No major gaps, but here are targeted improvements based on code patterns/invariants:

#### 1. **UI/UX: Quick Multi-Set Add**
   - **Problem**: addExerciseAsOneSet() (main.js) adds one set (reps=10 default); users repeat for volume.
   - **Fix**: Add UI in work-controls: reps slider (3-20), sets count (1-8). POST to new `api/workout/add_sets.php` (plural): `{exercise_id, exercise_name, sets: [{reps, load_lbs?, stimulus?, muscles?}]}`. Loop `INSERT` in PHP like add_set.php. Use workout_summary() for totals.
   - **Edge**: Validate total_reps <1000/workout; error "too_many_sets".

#### 2. **Per-Set Enhancements (RPE/RIR/Notes)**
   - **Problem**: stimulus simplistic (computeStimulusSingleSet(): vol/12 * load_factor); no subjective effort.
   - **DB**: Add workout_sets cols: `rpe` (int 1-10 nullable), `rir` (int 0-5 nullable), `notes` (varchar(255) nullable). Update/insert in add_set.php/update_set.php (nullable_float/intv() helpers).
   - **Frontend**: Add inputs in setrow (main.js::renderWorkoutEditor()): RPE dropdown, RIR slider, notes textarea. Compute stimulus = old + (10-rpe)/10 * 0.5 (high RPE boosts).
   - **Heat**: In rebuildMuscleFromLogs(), multiply stim *= (rpe_factor || 1).
   - **Invariant**: Validate rpe 6-10 (below=bad form); notes sanitized.

#### 3. **Workout-Level Metadata**
   - **Problem**: No titles/notes; workouts anonymous (#ID only).
   - **DB**: workouts: `title` (varchar(128)), `notes` (text).
   - **API**: start.php/end.php accept `{title?, notes?}`; list_workouts.php/get_workout.php include. UI: workout editor head input.
   - **Migration**: Backfill legacy from workout_date.

#### 4. **Advanced Features**
   - **Supersets/Dropsets**: Flag in workout_sets: `set_type` enum('normal','superset','drop','warmup'). Group in renderWorkoutEditor() (groupSetsByExercise()).
   - **Progress Tracking**: New table `personal_bests` (exercise_id, user_id, reps, load_lbs, achieved_at). POST `api/workout/check_pb.php` on add_set.php success; notify UI.
   - **Export**: `api/workout/export.php?format=csv&workout_id?` (paginated). Use fputcsv() on workout_sets JOIN exercises.

#### 5. **Validation/Edges**
   - **Stricter**: Enforce muscles_json non-empty (add_set.php); validate keys vs lib/muscleMap.js GROUPS.
   - **Autoclose**: Configurable via env (WORKOUT_AUTOCLOSE_SECONDS).
   - **Offline**: Cache viewingSets in LS (like ai_chat_v2); sync on reconnect (apiJson() retry).
   - **Perf**: overallCache.maxWorkouts=40 ok; index workout_sets(workout_id, created_at).

#### 6. **Testing/Metrics**
   - Add `api/workout/stats.php`: total volume/load per group/week (SUM(stimulus * w) GROUP BY muscle_group EXTRACT(WEEK)).
   - Unit: Mock PDO in _lib.php tests.

These build on existing (e.g., json_ok()/require_keys()). No DB dump shows constraints; verify indexes on workout_sets(workout_id, user_id). Prototype: Extend add_set.php → add_sets.php first. Not supported: Multi-exercise templates (no table). Next: Inspect full DB schema via grok_manual_dump.php --db=1.

### Q: what tips for improving this system would you give?
Here are targeted improvement tips based on code patterns in `main.js`, `api/workout/*.php`, `lib/recovery.js`, `ai_chat.js`, and related files. These leverage existing invariants (e.g., `muscles_json` validation in `add_set.php`, 5h autoclose in `_lib.php::autoclose_if_needed()`), DB schema (`workout_sets` stimulus 0-5, `exercises` weights 0-1), and flows (e.g., `rebuildMuscleFromLogs()` in `main.js`).

#### 1. **Performance: Optimize Heat Rebuilds**
   - **Issue**: `rebuildHeatNow()` in `main.js` fetches up to 40 workouts via `list_workouts.php` + `get_workout.php` every 2min (`overallCache.maxAgeMs`), potentially slow with many sets.
   - **Tips**:
     - Add DB view/aggregate: New `api/workout/heat_summary.php` querying `SUM(stimulus * w) GROUP BY muscle_group, DATE(created_at)` JOIN `workout_sets` + `exercises` (use `weights_json` → `JSON_EXTRACT`). Cache in Redis/memcached.
     - Client: Increase `overallCache.maxAgeMs` to 5min; debounce `rebuildHeatNow()` on set changes.
     - Edge: Index `workout_sets(workout_id, created_at, user_id)` (check via `grok_manual_dump.php --db=1`).

#### 2. **Workout UX: Multi-Set / Templates**
   - **Issue**: `addExerciseAsOneSet()` (main.js) adds single sets (reps=10 default via `computeStimulusSingleSet()`); repeats needed for volume.
   - **Tips**:
     - New `api/workout/add_sets.php`: Accept `{exercise_id, sets:[{reps,load_lbs?,muscles?}]}`; loop `INSERT` like `add_set.php`. UI: Add sets slider (3-8) in `work-controls`.
     - Templates: New `workout_templates` table (`name, sets_json`); `start.php` → `{template_id?}` param populates sets.
     - Invariant: Enforce `total_reps <2000/workout` in `_lib.php::require_keys()`.

#### 3. **AI/Exercises: Better Validation + Discovery**
   - **Issue**: `ai_chat.php` allows 1-6 groups (`$allowedIds`), normalizes via `normProposal()`; duplicates possible despite `exactMatchExercise()`.
   - **Tips**:
     - UI (`ai_chat.js`): Add search/filter in proposals (`renderProposal()`); auto-accept low-confidence (<0.5) after confirm.
     - Backend: `exercises_list.php` → add `muscles_summary_json` col (top 3 groups); query for fuzzy matches in `ai_chat.php` system prompt.
     - Extend: New `api/exercises/search.php?q=str` using `MATCH(name) AGAINST` (add FULLTEXT index).

#### 4. **Recovery/Heat: Subjective Inputs + Alerts**
   - **Issue**: `recovery.js::computeHeat()` uses fixed halfLifeHrs=36, stimulus=vol/12*load_factor; no RPE/RIR.
   - **Tips**:
     - DB: Add `workout_sets.rpe` (1-10), `rir` (0-5); `update_set.php` validates 6-10 RPE. Adjust `stim *= (10-rpe)/10 * 0.5` in `rebuildMuscleFromLogs()`.
     - Alerts: `generateRecs()` → push notifications via ServiceWorker if `overdo` (heat>0.8 + <24h).
     - Personalize: Per-user `halfLifeHrs` in new `user_prefs` table.

#### 5. **Reliability: Offline + Error Resilience**
   - **Issue**: No offline (`apiJson()` no retry); uploads in `ai_upload.php` <4.5MB but no resumable.
   - **Tips**:
     - IndexedDB: Mirror `viewingSets`/`overallCache` (like `musclemap_ai_chat_v2` LS); sync on `fetch()` success (`main.js::apiJson()` → retry 3x w/ exp backoff).
     - Errors: `bad()` helpers → consistent codes (e.g., 409 autoclose); `main.js` → toast via `alert()` wrapper.
     - Cleanup: Cron `/uploads/ai_tmp/` TTL (already best-effort in `ai_upload.php`).

#### 6. **Scaling: Multi-User Prep**
   - **Issue**: Hardcoded `GLOBAL_USER_ID=0` (`db.php`); single-user assumed.
   - **Tips**: See prior Q&A on auth/users table. Quick win: Env var `USER_ID` override in `db.php`; per-user `/uploads/{uid}/ai_tmp/`.

#### 7. **Testing/Monitoring**
   - Unit: Mock PDO in `_lib.php` helpers; test `weightsNormalize()` edge (empty/negative).
   - Metrics: `api/workout/stats.php` → weekly volume per group (`SUM(stimulus)`).
   - Deploy: Static files; PHP-FPM + MySQL indexes on `workout_sets(user_id, workout_id)`.

These are incremental, code-aligned changes (e.g., extend `json_ok()` patterns). No full DB dump in files, so verify schema/constraints via `grok_manual_dump.php --db=1`. Prototype: Multi-set add first (`add_sets.php`).

### Q: q
The query "q" is unclear and not supported as a specific developer question by the provided files or current manual. No matching functionality, endpoint, or data model reference found (e.g., no "q" param/field in api/workout/*.php, main.js, or DB tables like workouts/workout_sets). Next: Clarify the question (e.g., "query workouts?"); inspect full DB schema via `grok_manual_dump.php --db=1`; grep code (`grep -r "q=" .` or `grep -r "q\?" .`).

### Q: is there a single source of truth for what muscle groups are? if not what is each source used for
No single source of truth (no DB table like `muscle_groups`; all hardcoded). Two primary lists match exactly but serve distinct purposes:

#### 1. **lib/muscleMap.js: `GROUPS` array** (primary for 3D frontend)
   - **List**: `[{id:"abs_upper",label:"Abs (upper)",tokens:["rectus_abdominis"],kind:"region"}, {id:"abs_lower",...}, ..., {id:"core",...}]` (24 groups; full list matches `ai_chat.php`).
   - **Used for**:
     - `classifyMeshName(name)`: Maps GLB mesh names (e.g., "rectus_abdominis_muscle") to groups via `tokens` (e.g., `hasAny(n, g.tokens)`). Returns `{kind:"gym", groups:["abs_upper"]}` for heat/picking.
     - 3D rendering: `applyClassification()` in `main.js`/`ai_chat.js` → gymMeshes/pickables; `applyHeatToMesh()`/`applyPreviewWeights()` uses `mesh.userData._muscle.groups`.
     - Muscle picking: Raycaster → `setSelected()` highlights via groups.
     - Heat/recommendations: `rebuildMuscleFromLogs()`/`generateRecs()` iterates known groups.
   - **Extensibility**: Add to `GROUPS` → auto-wires 3D; call `bustExercisesCache()` if needed.

#### 2. **api/ai_chat.php: `$allowedIds` array** (AI/backend validation)
   - **List**: `["abs_upper","abs_lower","obliques_external","obliques_internal","core_deep","chest","lats",...,"core"]` (exact GROUPS ids).
   - **Used for**:
     - `$allowedSet = array_fill_keys($allowedIds, true)` → `$normProposal()` filters `weights` keys (ignores invalid); enforces <=6 groups, 0-1 floats.
     - System prompt: `"Allowed muscle group ids ONLY: [${implode(", ", $allowedIds)}]"` → xAI grok-4-0709 proposals.
     - Prevents bad data in `exercises.weights_json`/`workout_sets.muscles_json` via `add_exercises.php` (indirect; validates snake_case/0-1 but no explicit allowed check).
   - **Extensibility**: Add to `$allowedIds` → AI respects; sync with `muscleMap.js GROUPS`.

#### Other uses/invariants (no new lists)
- **DB/JSON**: `exercises.weights_json`, `workout_sets.muscles_json` store `{ "abs_upper": 0.85, "chest": 0.42 }` (snake_case keys, 0-1 validated in `add_exercises.php`/`add_set.php`; no DB enforcement).
- **No frontend cache/DB**: `lib/exercises.js` caches exercises (not groups); heat uses `gymMeshes.groups`.
- **Edge**: Mismatch → AI rejects proposals (`normProposal()` null → "question" reply); 3D ignores unknown meshes (`kind:"ignore"`). Manual notes: "Update 3D classifyMeshName(); Bust cache".

Supported by code (exact lists match); sync them for consistency. Next: Grep `GROUPS|allowedIds` or DB sample (`grok_manual_dump.php --db=1`) for custom entries.

### Q: q
The query "q" is unclear and not supported as a specific developer question by the provided files or current manual. No matching functionality, endpoint, or data model reference found (e.g., no "q" param/field in `api/workout/*.php`, `main.js`, `ai_chat.js`, or DB tables like `workouts`/`workout_sets`). Next: Clarify the question (e.g., "query workouts?"); inspect full DB schema via `grok_manual_dump.php --db=1`; grep code (`grep -r "q=" .` or `grep -r "q\?" .`).

### Q: how would we implement deleting workouts, also we should make it so that if a workout is ended and has 0 exercises it just deletes itself, we should also make it so that when you add an exercise and change any vaulue, be it reps or weight it automatically refreshes the 3d model
Deleting workouts is not supported (no endpoint like `api/workout/delete.php`; `workout_sets` likely lacks `ON DELETE CASCADE` per code patterns in `migrate_from_legacy.php`). Auto-delete empty ended workouts fits `end.php` + `workout_summary()` (already queries `COUNT(*)` from `workout_sets`). 3D refresh (heat) already happens automatically on add/update/delete sets via `main.js::onChange()`/`addExerciseAsOneSet()` → `rebuildHeatNow()` → `applyHeatToAllMeshes()` (calls `computeHeat()` per group, updates `material.emissive`); overall cache invalidates via `overallCache.lastBuiltAt=0`. Here's code-aligned implementation:

#### 1. **New Endpoint: `api/workout/delete.php`** (POST `{id:int}`)
   - Use `_lib.php` helpers (`user_id()`, `json_ok()/json_err()`, `read_json_body()`).
   - Check ownership: `SELECT workout_id FROM workout_sets WHERE workout_id=? AND user_id=?` or direct `workouts WHERE id=? AND user_id=?`.
   - Delete sets: `DELETE FROM workout_sets WHERE workout_id=? AND user_id=?` (multi-row).
   - Delete workout: `DELETE FROM workouts WHERE id=? AND user_id=?`.
   - Response: `{ok, deleted:bool, summary:{total_reps:0,...}}` via `workout_summary()` post-delete.
   ```php
   // api/workout/delete.php
   require __DIR__."/_lib.php";
   $uid = user_id(); $data=read_json_body(); require_keys($data,["id"]);
   $wid=intv($data["id"],1);
   $cur=$pdo->prepare("SELECT id FROM workouts WHERE id=? AND user_id=?"); $cur->execute([$wid,$uid]);
   if (!$cur->fetch()) json_err("Workout not found/unauthorized",404);
   $pdo->prepare("DELETE FROM workout_sets WHERE workout_id=? AND user_id=?")->execute([$wid,$uid]);
   $pdo->prepare("DELETE FROM workouts WHERE id=? AND user_id=?")->execute([$wid,$uid]);
   json_ok(["deleted"=>true]);
   ```
   - Errors: `no_sets` if empty; `ended_only` if active (`ended_at IS NULL` check).
   - Invariant: Call `autoclose_if_needed()` first; validate `user_id` ownership.

#### 2. **Auto-Delete Empty Ended Workouts** (modify `api/workout/end.php`)
   - After `UPDATE workouts SET ended_at=?...`, fetch `workout_summary($pdo,$wid)["sets_count"]`.
   - If `0`: Delete as above (sets already 0).
   ```php
   // In end.php after UPDATE:
   $sum=workout_summary($pdo,$wid); if($sum["sets_count"]===0){
     $pdo->prepare("DELETE FROM workout_sets WHERE workout_id=? AND user_id=?")->execute([$wid,$uid]);
     $pdo->prepare("DELETE FROM workouts WHERE id=? AND user_id=?")->execute([$wid,$uid]);
     json_ok(["ended"=>true,"auto_deleted"=>true,"reason"=>"empty"]);
   }
   ```
   - Edge: Legacy migration (`migrate_from_legacy.php`) creates workouts even if empty dates; test via CLI `--dry=1`.

#### 3. **UI: Delete Button** (`main.js`)
   - In `renderWorkoutEditor()`/`refreshHistory()`: Add delete btn to `.workcard`/`excard` when `viewingWorkoutId`/`!activeWorkout.id` (ended).
   - Handler: `confirm()` → `apiJson(API_WORKOUT_DELETE,{method:"POST",body:JSON.stringify({id:wid})})` → `exitPastWorkoutEdit()`/`refreshHistory()`/`overallCache.lastBuiltAt=0`.
   - History: `<button class="iconbtn delWorkoutBtn" data-wid="${w.id}">🗑️</button>` in `.workcard-top`; wire `async(e)=>{await apiJson(...); await refreshHistory();}`.

#### 4. **3D Auto-Refresh** (already works; minor tweaks)
   - **Add**: `main.js::addExerciseAsOneSet()` already → `loadCurrentWorkoutSets()` → `rebuildHeatNow()` (if `heatMode="workout"`) → `setStateLogsForHeat()` → `rebuildMuscleFromLogs()` → `applyHeatToAllMeshes()`.
   - **Change reps/weight**: `onChange()` (live) → `apiJson(update_set.php)` → `rebuildHeatNow()` + `refreshHistory()` (summary).
   - **Past edits**: `savePastEdits()` → `viewWorkout()` → `rebuildHeatNow()` + `overallCache.lastBuiltAt=0`.
   - Tweak: Always `await rebuildHeatNow()` post-change (not just `heatMode="workout"`); debounce via `lastHeatRebuildAt` (already 2s in `animate()`).
   - Edge: `setsToHeatLogs()` ensures `muscles` from `workout_sets.muscles_json` or `exerciseWeightsById`; validate non-empty in `add_set.php` (`if(!$clean) json_err("empty_muscles")`).

#### 5. **Testing/Edges**
   - **Perf**: `list_workouts.php` paginates; delete invalidates `overallCache` (40 workouts cap).
   - **Autoclose**: `_lib.php::autoclose_if_needed()` (5h) → empty auto-delete on `end.php`.
   - **Migration**: `migrate_from_legacy.php --truncate=1` clears; re-run post-delete tests.
   - No DB dump shows FKs/constraints; verify `SHOW CREATE TABLE workouts;` via `grok_manual_dump.php --db=1`. Prototype: Add `delete.php` + `end.php` mod first.

Supported by patterns (`delete_set.php`, `workout_summary()`); next: Full DB schema (`grok_manual_dump.php --db=1`) for indexes/FKs.
