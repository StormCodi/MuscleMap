<?php
// api/workout/status.php
declare(strict_types=1);

require __DIR__ . "/_lib.php";

$uid = user_id();
$active = get_active_workout($pdo, $uid);

if (!$active) {
  json_ok(["active" => null]);
}

$wid = (int)$active["id"];
json_ok([
  "active" => [
    "id" => $wid,
    "started_at" => $active["started_at"],
    "ended_at" => $active["ended_at"],
    "auto_closed" => (int)$active["auto_closed"],
    "summary" => workout_summary($pdo, $wid),
  ]
]);
