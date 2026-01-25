<?php
// api/workout/get_current.php
declare(strict_types=1);

require __DIR__ . "/_lib.php";

$uid = user_id();
$active = get_active_workout($pdo, $uid);

if (!$active) {
  json_ok(["active" => null, "sets" => []]);
}

$wid = (int)$active["id"];

$sq = $pdo->prepare("
  SELECT id, workout_id, exercise_id, exercise_name, reps, load_lbs, stimulus, muscles_json, created_at, updated_at
  FROM workout_sets
  WHERE workout_id = ? AND user_id = ?
  ORDER BY id ASC
");
$sq->execute([$wid, $uid]);

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
  "active" => [
    "id" => $wid,
    "started_at" => $active["started_at"],
    "ended_at" => $active["ended_at"],
    "auto_closed" => (int)$active["auto_closed"],
    "summary" => workout_summary($pdo, $wid),
  ],
  "sets" => $sets,
]);
