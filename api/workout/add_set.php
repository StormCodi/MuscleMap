<?php
// api/workout/add_set.php
declare(strict_types=1);

require __DIR__ . "/_lib.php";

$uid = user_id();
$active = get_active_workout($pdo, $uid);
if (!$active) json_err("No active workout. Start workout first.", 409);

$wid = (int)$active["id"];
$data = read_json_body();

require_keys($data, [
  "exercise_id", "exercise_name",
  "reps", "stimulus", "muscles"
]);

$exerciseId = strv($data["exercise_id"]);
$exerciseName = strv($data["exercise_name"]);
$reps = intv($data["reps"], 1, 1000);
$load = array_key_exists("load_lbs", $data) ? nullable_float($data["load_lbs"]) : null;
$stim = floatv($data["stimulus"], 0.0, 5.0);

$muscles = $data["muscles"];
if (!is_array($muscles)) json_err("muscles must be an object map", 400);

// sanitize muscles map: keep only finite positive weights
$clean = [];
foreach ($muscles as $k => $v) {
  $gid = strv($k);
  if ($gid === "") continue;
  if (!is_numeric($v)) continue;
  $w = (float)$v;
  if (!is_finite($w) || $w <= 0) continue;
  $clean[$gid] = $w;
}

$musclesJson = json_encode($clean, JSON_UNESCAPED_SLASHES);
if ($musclesJson === false) $musclesJson = null;

$now = now_sql();

$ins = $pdo->prepare("
  INSERT INTO workout_sets
    (workout_id, user_id, exercise_id, exercise_name, reps, load_lbs, stimulus, muscles_json, created_at, updated_at)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
");
$ins->execute([
  $wid, $uid,
  $exerciseId, $exerciseName,
  $reps, $load,
  $stim, $musclesJson,
  $now, $now
]);

$setId = (int)$pdo->lastInsertId();

// touch workout updated_at
$upd = $pdo->prepare("UPDATE workouts SET updated_at = ? WHERE id = ? AND user_id = ?");
$upd->execute([$now, $wid, $uid]);

json_ok([
  "set" => [
    "id" => $setId,
    "workout_id" => $wid,
    "exercise_id" => $exerciseId,
    "exercise_name" => $exerciseName,
    "reps" => $reps,
    "load_lbs" => $load,
    "stimulus" => $stim,
    "muscles" => $clean,
    "created_at" => $now,
    "updated_at" => $now,
  ],
  "summary" => workout_summary($pdo, $wid),
]);
