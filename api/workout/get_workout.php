<?php
// api/workout/get_workout.php
declare(strict_types=1);

require __DIR__ . "/_lib.php";

$uid = user_id();

$workoutId = null;
if ($_SERVER["REQUEST_METHOD"] === "GET") {
  $workoutId = isset($_GET["id"]) ? (int)$_GET["id"] : 0;
} else {
  $data = read_json_body();
  $workoutId = isset($data["id"]) ? (int)$data["id"] : 0;
}
if ($workoutId <= 0) json_err("Missing workout id");

autoclose_if_needed($pdo, $uid);

$wq = $pdo->prepare("
  SELECT id, user_id, started_at, ended_at, auto_closed, created_at, updated_at
  FROM workouts
  WHERE id = ? AND user_id = ?
  LIMIT 1
");
$wq->execute([$workoutId, $uid]);
$w = $wq->fetch(PDO::FETCH_ASSOC);
if (!$w) json_err("Workout not found", 404);

$sq = $pdo->prepare("
  SELECT
    id, workout_id, exercise_id, exercise_name,
    reps, load_lbs, stimulus, muscles_json,
    created_at, updated_at
  FROM workout_sets
  WHERE workout_id = ? AND user_id = ?
  ORDER BY id ASC
");
$sq->execute([$workoutId, $uid]);
$sets = [];
while ($r = $sq->fetch(PDO::FETCH_ASSOC)) {
  $mj = $r["muscles_json"];
  $muscles = null;
  if ($mj) {
    if (is_string($mj)) {
      $tmp = json_decode($mj, true);
      $muscles = is_array($tmp) ? $tmp : null;
    } elseif (is_array($mj)) {
      $muscles = $mj;
    }
  }

  $sets[] = [
    "id" => (int)$r["id"],
    "workout_id" => (int)$r["workout_id"],
    "exercise_id" => (string)$r["exercise_id"],
    "exercise_name" => (string)$r["exercise_name"],
    "reps" => (int)$r["reps"],
    "load_lbs" => ($r["load_lbs"] === null ? null : (float)$r["load_lbs"]),
    "stimulus" => (float)$r["stimulus"],
    "muscles" => $muscles,
    "created_at" => (string)$r["created_at"],
    "updated_at" => (string)$r["updated_at"],
  ];
}

json_ok([
  "workout" => [
    "id" => (int)$w["id"],
    "started_at" => (string)$w["started_at"],
    "ended_at" => ($w["ended_at"] === null ? null : (string)$w["ended_at"]),
    "auto_closed" => (int)$w["auto_closed"],
    "created_at" => (string)$w["created_at"],
    "updated_at" => (string)$w["updated_at"],
    "summary" => workout_summary($pdo, (int)$w["id"]),
  ],
  "sets" => $sets,
]);
