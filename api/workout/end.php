<?php
// api/workout/end.php
declare(strict_types=1);

require __DIR__ . "/_lib.php";

$uid = user_id();
$active = get_active_workout($pdo, $uid);
if (!$active) json_ok(["ended" => false, "message" => "No active workout"]);

$wid = (int)$active["id"];
$now = now_sql();

$upd = $pdo->prepare("
  UPDATE workouts
  SET ended_at = ?, updated_at = ?
  WHERE id = ? AND user_id = ? AND ended_at IS NULL
");
$upd->execute([$now, $now, $wid, $uid]);

json_ok([
  "ended" => true,
  "workout_id" => $wid,
  "ended_at" => $now,
  "summary" => workout_summary($pdo, $wid),
]);
