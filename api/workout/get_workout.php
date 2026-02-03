<?php
// api/workout/get_workout.php
declare(strict_types=1);

require __DIR__ . "/_lib.php";

$uid = user_id();

$wid = 0;
$method = $_SERVER["REQUEST_METHOD"] ?? "GET";

if ($method === "GET") {
  $wid = isset($_GET["id"]) ? (int)$_GET["id"] : 0;
} else {
  $data = read_json_body();
  $wid = isset($data["id"]) ? (int)$data["id"] : 0;
}

if ($wid <= 0) json_err("missing_id", 400);

$wq = $pdo->prepare("
  SELECT id, user_id, started_at, ended_at, auto_closed, created_at, updated_at
  FROM workouts
  WHERE id = ? AND user_id = ?
  LIMIT 1
");
$wq->execute([$wid, $uid]);
$w = $wq->fetch(PDO::FETCH_ASSOC);
if (!$w) json_err("not_found", 404);

$sets = [];
$sq = $pdo->prepare("
  SELECT id, workout_id, exercise_id, exercise_name, reps, load_lbs, stimulus, completed, muscles_json, created_at, updated_at
  FROM workout_sets
  WHERE user_id = ? AND workout_id = ?
  ORDER BY id ASC
");
$sq->execute([$uid, $wid]);

while ($r = $sq->fetch(PDO::FETCH_ASSOC)) {
  $mus = null;
  if (!empty($r["muscles_json"])) {
    $m = json_decode((string)$r["muscles_json"], true);
    if (is_array($m)) $mus = $m;
  }

  $sets[] = [
    "id" => (int)$r["id"],
    "workout_id" => (int)$r["workout_id"],
    "exercise_id" => (string)$r["exercise_id"],
    "exercise_name" => (string)$r["exercise_name"],
    "reps" => (int)$r["reps"],
    "load_lbs" => ($r["load_lbs"] === null) ? null : (float)$r["load_lbs"],
    "stimulus" => (float)$r["stimulus"],
    "completed" => (int)$r["completed"],
    "muscles" => $mus,
    "created_at" => (string)$r["created_at"],
    "updated_at" => (string)$r["updated_at"],
  ];
}

json_ok([
  "workout" => [
    "id" => (int)$w["id"],
    "started_at" => $w["started_at"],
    "ended_at" => $w["ended_at"],
    "auto_closed" => (int)$w["auto_closed"],
    "created_at" => $w["created_at"],
    "updated_at" => $w["updated_at"],
    "summary" => workout_summary($pdo, (int)$w["id"]),
  ],
  "sets" => $sets,
]);
