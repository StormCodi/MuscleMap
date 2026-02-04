<?php
// api/workout/delete_sets_for_exercise.php
declare(strict_types=1);

require __DIR__ . "/_lib.php";

if (($_SERVER["REQUEST_METHOD"] ?? "") !== "POST") {
  json_err("method_not_allowed", 405);
}

$uid = user_id();
$active = get_active_workout($pdo, $uid);
if (!$active) json_err("No active workout. Start workout first.", 409);

$wid = (int)$active["id"];
$data = read_json_body();

require_keys($data, ["exercise_id"]);
$exerciseId = strv($data["exercise_id"]);
if ($exerciseId === "") json_err("missing_exercise_id", 400);

$now = now_sql();

$del = $pdo->prepare("
  DELETE FROM workout_sets
  WHERE user_id = ?
    AND workout_id = ?
    AND exercise_id = ?
");
$del->execute([$uid, $wid, $exerciseId]);

$deleted = (int)$del->rowCount();

// touch workout updated_at
$upd = $pdo->prepare("UPDATE workouts SET updated_at = ? WHERE id = ? AND user_id = ?");
$upd->execute([$now, $wid, $uid]);

json_ok([
  "deleted" => $deleted,
  "workout_id" => $wid,
  "exercise_id" => $exerciseId,
  "summary" => workout_summary($pdo, $wid),
]);
