<?php
// api/workout/start.php
declare(strict_types=1);

require __DIR__ . "/_lib.php";

$uid = user_id();

// If already active, return it (after autoclose check)
$active = get_active_workout($pdo, $uid);
if ($active) {
  $wid = (int)$active["id"];
  json_ok([
    "workout" => [
      "id" => $wid,
      "started_at" => $active["started_at"],
      "ended_at" => $active["ended_at"],
      "auto_closed" => (int)$active["auto_closed"],
      "summary" => workout_summary($pdo, $wid),
    ]
  ]);
}

$now = now_sql();

$ins = $pdo->prepare("
  INSERT INTO workouts (user_id, started_at, ended_at, auto_closed, created_at, updated_at)
  VALUES (?, ?, NULL, 0, ?, ?)
");
$ins->execute([$uid, $now, $now, $now]);

$wid = (int)$pdo->lastInsertId();

json_ok([
  "workout" => [
    "id" => $wid,
    "started_at" => $now,
    "ended_at" => null,
    "auto_closed" => 0,
    "summary" => workout_summary($pdo, $wid),
  ]
]);
