# MuscleMap Developer Manual

MuscleMap is a web app for tracking workouts on a 3D body model. Muscles "heat up" based on training load/decay. Features workout logging, exercise management, AI exercise proposals via image/text chat (xAI Grok), and recovery recommendations. Single-user demo (GLOBAL_USER_ID=0). No auth/sessions.

## High-Level Architecture

```
Browser (index.html / ai_chat.html)
├── Three.js 3D body model (assets/models/body.glb)
├── JS modules (lib/*.js, main.js, ai_chat.js)
│   ├── Heat engine (lib/heat_engine.js): fetches logs -> computes muscle load
│   ├── Renderer (lib/renderer3d.js): paints heat/selection
│   └── Workout UI (lib/workout_ui.js): CRUD via api/workout/*
├── API calls (fetch + JSON)
└── PHP API (api/*.php)
    ├── DB (api/db.php: MySQL PDO)
    ├── Workout endpoints (api/workout/*.php)
    ├── Exercises (api/exercises_list.php, api/add_exercises.php)
    └── AI (api/ai_upload.php -> ai_chat.php -> xAI Grok)
```

End-to-end flow (workout log): UI (main.js) -> lib/workout_ui.js -> api/workout/add_set.php -> INSERT workout_sets -> lib/heat_engine.js fetches via list_workouts.php/get_workout.php -> rebuildMuscleFromLogs() -> renderer3d.applyHeatToAllMeshes()

AI flow: ai_chat.html/js -> api/ai_upload.php (store /uploads/ai_tmp/{token}.ext) -> api/ai_chat.php (load images as data:base64 -> xAI prompt w/ exercises list -> parse JSON reply) -> render cards -> api/add_exercises.php (UPSERT exercises)

## 1) Directory/Module Map

- **Root**:
  - `index.html`: Main app page (3D viewer + workout UI).
  - `ai_chat.html`: AI exercise builder chat (separate page).
  - `style.css`, `ai_chat.css`: Global + AI-specific styles.
  - `main.js`: App bootstrap, orchestrates renderer/heat/workoutUI/recs.
  - `grok_manual_dump.php`, `token_audit.php`: Dev tools (manual gen, token count).

- **lib/** (JS modules, ES modules via importmap):
  | File | Purpose |
  |------|---------|
  | `api.js` | API constants (e.g., API.WORKOUT_ADD_SET), apiJson() wrapper. |
  | `exercises.js` | getAllExercisesCached() from api/exercises_list.php (TTL 60s). |
  | `heat_engine.js` | createHeatEngine(): fetches workouts/logs -> rebuildMuscleFromLogs() -> state.muscle {load,lastTrained}. Modes: overall/workout. |
  | `muscleMap.js` | classifyMeshName(name): {kind:"gym/shell/ignore", groups:["chest"]}. GROUPS array (26 groups). |
  | `recovery.js` | computeHeat(), applyStimulus(), tickDecay() (half-life 36h). |
  | `recs.js` | generateRecs(): warnings/nudges from heat/overdo/neglected. |
  | `renderer3d.js` | createRenderer3D(): loads GLB, raycast picking, applyHeatToAllMeshes(). |
  | `storage.js` | loadState/saveState() localStorage (legacy/not used). |
  | `workout_ui.js` | createWorkoutUI(): editor/history/paging, addExerciseAsOneSet(). |

- **api/** (PHP endpoints, all return JSON {ok:true/false,error}):
  | Subdir/File | Purpose |
  |-------------|---------|
  | `db.php` | PDO connect (musclemap@localhost, GLOBAL_USER_ID=0). |
  | `exercises_list.php` | GET exercises (active for user). |
  | `add_exercises.php` | POST {id,name,w,source} -> UPSERT exercises. |
  | `ai_upload.php` | POST image -> token/url (/uploads/ai_tmp/{token}.jpg/png/webp, TTL 24h cleanup). |
  | `ai_chat.php` | POST {history,text,image_tokens} -> xAI Grok -> parse reply JSON. |
  | `workout/*` | Full CRUD: start.php, add_set.php, update_set.php, delete_set.php, etc. |
  | Legacy: `get_exercises.php`, `get_logs.php`, `log_workout.php`, `state_reset.php` (commented). |

- **assets/models/**: body.glb (fallback draco), used by Three.js GLTFLoader.

- **vendor/**: Three.js modules.

## 2) Data Model

Inferred from queries (no full DB dump; only code refs). MySQL (utf8mb4). Single user (GLOBAL_USER_ID=0).

| Table | Key Fields |
|-------|------------|
| **exercises** | `user_id` (int), `exercise_key` (varchar, UNIQUE w/user_id), `name` (varchar<=128), `weights_json` (JSON {group_id:0.0-1.0}), `source` ("user"/"ai"), `is_active` (bool), `updated_at` (timestamp). |
| **workouts** | `id` (auto), `user_id`, `started_at`/`ended_at`/`updated_at`/`created_at` (datetime), `auto_closed` (bool, autoclose >5h). |
| **workout_sets** | `id` (auto), `workout_id`/`user_id`, `exercise_id`/`exercise_name` (str), `reps` (int>0), `load_lbs` (float|null), `stimulus` (float 0-5), `muscles_json` (JSON {group_id:float>0}), `created_at`/`updated_at`. |
| **workout_logs** (legacy?) | `id`, `workout_date` (date?), `exercise_id`/`exercise_name`, `sets`/`reps`, `load_lbs`, `stimulus`, `created_at`, `muscles_json`. |

Invariants: weights_json/muscles_json snake_case keys from lib/muscleMap.js GROUPS (e.g., "chest":0.75). stimulus=computeStimulusSingleSet(reps,load_lbs) ~ (reps/12)*(1+load/200).

## 3) API Endpoints

All: Content-Type:application/json, {ok:bool,error?:str}. Errors: 400 bad_json/missing_*, 500 server_error/db_error, 413 too_large.

| Path | Method | Request | Response | Notes |
|------|--------|---------|----------|-------|
| `/api/exercises_list.php` | GET | - | {exercises:[{id,name,w:{group:0-1}}]} | Active exercises. |
| `/api/add_exercises.php` | POST | {id:str(^[a-z0-9_]{2,64}$),name:str<=128,w:{group:0-1},source?:"ai"} | {ok:true} | UPSERT by (user_id,exercise_key). Validates/clamps w. |
| `/api/ai_upload.php` | POST | Multipart image (jpg/png/webp <=4.5MB) | {token:str32hex,url:str} | Stores /uploads/ai_tmp/, cleans >24h. |
| `/api/ai_chat.php` | POST | {history:[{role,text}],text:str,image_tokens:[str32hex]} | {assistant:{text,reply:{type:"propose_add",proposal:{exercise_key,name,weights,confidence}},raw_json},history} | xAI Grok (grok-4-0709), schema-enforced JSON reply. Loads images as data:base64. |
| `/api/workout/start.php` | POST/GET | - | {workout:{id,started_at,ended_at?,summary:{sets_count,exercises_count,total_reps?}}} | Autoclose >5h. Returns existing if active. |
| `/api/workout/add_set.php` | POST | {exercise_id,name,reps:int1-1000,load_lbs?:float|null,stimulus:float0-5,muscles:{group:float>0}} | {set:{id,...},summary} | Sanitizes muscles (finite>0). |
| `/api/workout/update_set.php` | POST | {set_id:int, reps?/load_lbs?/stimulus?/muscles?} | {updated:true,summary} | Partial update, allows ended workouts. |
| `/api/workout/delete_set.php` | POST | {set_id:int} | {deleted:true,summary} | - |
| `/api/workout/end.php` | POST/GET | - | {ended:bool,...} | - |
| `/api/workout/get_current.php` | GET | - | {active?:{id,...},sets:[{id,exercise_id,name,reps,load_lbs?,stimulus,muscles?,...}]} | Autoclose check. |
| `/api/workout/get_workout.php?id=N` | GET/POST | {id:int} (POST) or ?id= (GET) | {workout:{id,started_at,...},sets:[...]} | - |
| `/api/workout/list_workouts.php?page=N&per=M` | GET | page=1/per=5 (def) | {page,pages,total,workouts:[{id,started_at,ended_at?,summary}]} | Newest first, per<=50. |
| `/api/workout/status.php` | GET | - | {active?:{id,...summary}} | Quick check. |

Legacy (not in main flow): get_logs.php (workout_logs), log_workout.php, state_reset.php (commented).

## 4) Frontend Flow

**Main app (index.html + main.js)**:
1. boot(): load exercises (exercises_list.php) -> populate <select id="exerciseSelect"> + heat.setExerciseWeightsById().
2. renderer3d.loadGLBWithFallback() -> classifyMeshName() on meshes -> pickables/gymMeshes.
3. workoutUI.boot() -> refreshStatus() (workout/status.php) -> loadCurrentWorkoutSets() (get_current.php).
4. animate(): tickTimer(), heat.tick() (decay) -> applyHeatToAllMeshes() -> renderFrame().
5. User: tap muscle -> raycast -> onSelect({groups}) -> setSelectedPanel().
6. Workout: startWorkout() (start.php) -> addExerciseAsOneSet() (add_set.php, computeStimulusSingleSet) -> onEditorSetsChanged(sets) -> heat.setWorkoutSets().
7. Heat toggle: setHeatMode("workout") -> heat.rebuildNow() (list_workouts.php + get_workout.php) -> paint.
8. Recs: generateRecs() from getAllGroupIds().

**AI chat (ai_chat.html + ai_chat.js)**:
1. loadPreviewGLB() (body.glb) -> classifyMeshName() -> gymMeshes.
2. User: text/images -> onPickImages() -> uploadOneImage(ai_upload.php) -> sendToServer(ai_chat.php).
3. Reply: renderReplyCard(reply.proposal) -> applyPreviewWeights(weights) (emissive glow).
4. Accept: acceptProposal(add_exercises.php) -> bustExercisesCache() (implicit refresh).

LocalStorage: ai_chat "musclemap_ai_chat_v2" (history), main "musclemap.v1" (unused).

## 5) AI Intake / MMJ schema explanation

Present in `api/ai_chat.php`. xAI Grok prompt enforces JSON-only reply (no markdown).

**MMJ Schema** (exact keys):
```json
{
  "type": "error"|"question"|"exists"|"propose_add"|"propose_add_many",
  "text": "str",
  "choices"?: ["str"],  // question only
  "id"?: "exercise_key", "name"?: "str",  // exists only
  "proposal"?: {        // propose_add only
    "exercise_key": "snake_case 2-64",
    "name": "str",
    "weights": {"group_id": 0.0-1.0},  // 1-6 groups from $allowedIds (26 fixed)
    "confidence": 0.0-1.0
  },
  "proposals"?: [proposal obj]  // propose_add_many (up to 6)
}
```
- Server normalizes: normalizeId()/weightsNormalize(), exactMatchExercise() vs DB exercises_list.php.
- Images: optional (<=6), data:base64 in user message.
- History: sliced -40, text-only returned.
- Fallback: question if invalid/low conf.

JS renders: cards w/ Accept/Preview/Reject buttons -> add_exercises.php.

## 6) How to Extend

- **New exercise**: AI chat (propose_add) -> Accept. Or POST add_exercises.php {id:"snake_pushups",name:"Snake Pushups",w:{"chest":0.8}}.
- **New muscle group**: lib/muscleMap.js GROUPS[] += {id:"new_group",tokens:["mesh_token"],label:"New"}. Update api/ai_chat.php $allowedIds. Refresh exercises (bust cache).
- **New endpoint**: api/new.php (use _lib.php helpers: json_ok()/read_json_body()). Queries w/ GLOBAL_USER_ID=0. Ex: copy add_set.php.
- **New GLB mesh**: Drop body.glb (draco ok). classifyMeshName() auto-maps via tokens (GROUPS/BIG_MUSCLE_FALLBACK).
- **Custom stimulus**: main.js computeStimulusSingleSet(reps,load_lbs).
- **Multi-user**: Replace GLOBAL_USER_ID w/ sessions/auth.

## 7) Troubleshooting

| Error | Where to Look |
|-------|---------------|
| "API ... non-JSON" | apiJson() (lib/api.js), server logs (PHP warnings). Check Content-Type. |
| "No active workout" (409) | api/workout/_lib.php get_active_workout() -> autoclose_if_needed (5h). |
| Model load fail | console (GLTFLoader), assets/models/body.glb exists? Fallback draco. |
| Heat not updating | heat.rebuildNow() (lib/heat_engine.js), api/workout/list_workouts.php pages. |
| AI "ai_not_structured_json" | api/ai_chat.php $assistantJson parse, xAI raw_json in ai_chat.js #jsonOut. Key: /etc/musclemap/xai_api_key. |
| Upload fail | api/ai_upload.php: mime/4.5MB, /uploads/ai_tmp/ writable. |
| Permissions/DB | MySQL musclemap@localhost/uJ8F!sP#Qz4mL@eV9Wc2. PDO exceptions in PHP error_log. |
| JS modules fail | importmap (three.js), network (no-store cache). |

Common: single-user (GLOBAL_USER_ID=0), refresh exercises_list.php after add_exercises.

## 8) Q&A

_Questions/answers appended over time._

## Q&A

_Questions and answers are appended here over time._

### Q: Muscle sensetivity is something that is all over the place, sometimes a muscle that hurts is marked as yellow, and a muscle you barely feel after an exercise is marked in red. To fix this we want to introdcuce a muscle sensitivity slider, when you select a muscle, where it states it's name it should have a slider, as you adjust it, the color of the muscle adjust live, so one day after an exercise you can mark how you truly feel, give me all the file, data, and any other kind of change required to do this, don't give me the code but but explain what files are involved in such a change and what issues and mistakes to look out for

**Overview**: Implementing a per-muscle sensitivity slider requires UI changes for live preview, state overrides in the heat engine/renderer, and persistent storage (new DB table/fields since none exist). Sensitivity would act as a multiplier (e.g., 0.5-2.0) on `load` in `computeHeat()` (lib/recovery.js), applied only to selected muscle's groups. Live updates via slider must not persist until saved; post-exercise use implies optional DB save/load. No current support for user overrides (state.muscle has only `load`, `lastTrained`, `lastPing` from heat_engine.js).

**Files/Sections Involved**:

1. **index.html** (UI structure):
   - In `.selected` div (id="selectedBox"), add `<input type="range" id="sensitivitySlider" min="0.5" max="2.0" step="0.1" value="1.0">` + label/output (e.g., "Sensitivity: 1.0x") below `.selected-name`.
   - Hide slider unless groups selected (via CSS/JS).

2. **style.css** (UI styling):
   - Style `#sensitivitySlider` (e.g., accent color `--accent`, thumb/track custom). Add `.sensitivity-output` for live value display. Ensure responsive (media query min-width:900px).

3. **main.js** (orchestration + slider handler):
   - DOM refs: Add `sensitivitySlider = document.getElementById("sensitivitySlider")`, `sensitivityOutput`.
   - In `setSelectedPanel()`: Show/hide slider, set initial value=1.0, wire `input` event to `onSensitivityChange(val)` (debounced, call `rebuildHeatAndPaint()`).
   - Expose sensitivity state (e.g., `sensitivityOverrides = {groupId: val}` Map).
   - `computeStimulusSingleSet()` unaffected (set-level). Add save btn? Call new API.
   - `boot()`: Load sensitivities from localStorage or API.
   - `animate()`: No change (tick uses existing state).

4. **lib/renderer3d.js** (visual feedback):
   - `applyHeatToMesh()` / `applyHeatToAllMeshes()`: Accept `sensitivityOverrides` param from main.js. In loop, for each group, fetch `override = sensitivityOverrides.get(g)`, multiply `h.heat *= override || 1.0` before `heatToVisual()`.
   - `setSelected()`: Pass selected groups to main.js `onSelect`.
   - Pitfall: Selection look (emissive/wireframe) overrides heat—apply sensitivity after. Multiple meshes/groups: slider affects max across selected groups.

5. **lib/recovery.js** / **lib/heat_engine.js** (logic):
   - `computeHeat(state, id)`: Add `sensitivity` param (default 1.0), `heat = clamp01((m.load * sensitivity) + 0.25 * freshness)`. Propagate from renderer.
   - heat_engine.js `rebuildMuscleFromLogs()` / `tick()`: No change (sensitivity is UI override, not baked into `state.muscle.load`).
   - Pitfall: Sensitivity must be transient (not decay with `tickDecay()`); store separately. Multi-group select: single slider? Average or per-group toggles?

6. **New/Modified API Endpoints** (api/*.php):
   - New: `api/sensitivity.php` (GET: list {group_id: float}, POST: UPSERT user sensitivities).
   - Use `api/db.php` PDO. New table `muscle_sensitivities` (user_id INT, group_id VARCHAR(64), sensitivity FLOAT(0.5-2.0), updated_at TIMESTAMP). UNIQUE(user_id, group_id).
   - Integrate like `exercises`: `exercises_list.php` pattern (SELECT WHERE user_id=GLOBAL_USER_ID).
   - `add_exercises.php`-style validation (clamp 0.5-2.0).
   - Pitfall: GLOBAL_USER_ID=0 single-user; future auth needs sessions. No current cleanup (add TTL?).

7. **lib/api.js** / **lib/exercises.js** (API helpers):
   - Add `API.SENSITIVITY_LIST`, `API.SENSITIVITY_SET`. Mirror `getAllExercisesCached()` with TTL cache for sensitivities Map.
   - `apiJson()` wrapper handles {ok,error}.

8. **DB Schema** (MySQL via api/db.php):
   - ALTER/CREATE `muscle_sensitivities` (fields as above). Backfill defaults=1.0 for GROUPS from lib/muscleMap.js.
   - Pitfall: No schema migration script (manual). Queries must filter `is_active`? No—add if needed. JSON fields unaffected.

9. **lib/muscleMap.js** (groups):
   - Use `GROUPS` for sensitivity keys (26 ids like "chest"). Validate slider against `getAllGroupIds()` from renderer.

**Data Flow Changes**:
- UI (slider) → main.js override Map → renderer3d.applyHeatToAllMeshes(overrides) → live paint.
- Save: main.js → api/sensitivity.php POST {group_id, sensitivity} → DB.
- Load: boot() → api/sensitivity_list.php → heat_engine.setSensitivityById(map) → computeHeat uses it.
- End-to-end: No AI/workout impact (visual only). Post-exercise: Select muscle → slider → save persists multiplier on future `load`.

**Invariants/Edge Cases**:
- **Permissions**: GLOBAL_USER_ID=0; multi-user needs auth (manual sec6).
- **Validation**: Slider 0.5-2.0 (clamp in JS/PHP). Invalid group_id? Ignore.
- **Multi-group**: Selected mesh.groups[0] as primary? Or avg/multi-slider (complex; start single).
- **Persistence**: localStorage fallback (lib/storage.js pattern, key="sensitivity.v1"). Sync on boot/save.
- **Performance**: Live slider → rebuildHeatAndPaint() every change (debounce 100ms). animate() tick unaffected.
- **Modes**: Workout/overall heat both respect sensitivity. Past workout edit? Apply too.
- **Decay**: Sensitivity multiplies post-decay `load`; doesn't alter DB stimulus/logs.

**Issues/Mistakes to Watch**:
- **State races**: animate() tick vs slider—pass overrides each `applyHeatToAllMeshes()`. Don't mutate `state.muscle`.
- **No DB field**: Inventing `muscle_sensitivities` ok (manual says "How to extend"), but test PDO in api/db.php creds.
- **GLB meshes**: Multiple meshes/group—slider affects all via group_id.
- **Mobile**: Slider touch (style.css @media max-width:900px stack).
- **Cache**: Bust sensitivity cache like `bustExercisesCache()` post-save.
- **Errors**: apiJson() throws on !ok; handle in main.js (e.g., slider=1.0). Console non-JSON (lib/api.js).
- **Testing**: No workouts? Sensitivity still previews (use dummy load). Autoclose (5h) irrelevant.
- **Over-engineering**: Start transient (localStorage only), add DB later. No AI integration needed.

Next inspect: Run `grok_manual_dump.php --db=1` for DB dump confirmation (no sensitivity table yet). Check lib/heat_engine.js `rebuildNow()` for override injection point.
