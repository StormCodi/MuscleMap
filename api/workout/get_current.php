<?php
// api/workout/get_current.php
declare(strict_types=1);

require __DIR__ . "/_lib.php";

$uid = user_id();
$active = get_active_workout($pdo, $uid);

$outActive = null;
$wid = 0;

if ($active) {
  $wid = (int)$active["id"];
  $outActive = [
    "id" => $wid,
    "started_at" => $active["started_at"],
    "ended_at" => $active["ended_at"],
    "auto_closed" => (int)$active["auto_closed"],
    "summary" => workout_summary($pdo, $wid),
  ];
}

$sets = [];
if ($wid > 0) {
  $q = $pdo->prepare("
    SELECT id, workout_id, exercise_id, exercise_name, reps, load_lbs, stimulus, completed, muscles_json, created_at, updated_at
    FROM workout_sets
    WHERE user_id = ? AND workout_id = ?
    ORDER BY id ASC
  ");
  $q->execute([$uid, $wid]);

  while ($r = $q->fetch(PDO::FETCH_ASSOC)) {
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
}

json_ok([
  "active" => $outActive,
  "sets" => $sets,
]);
