<?php
// api/workout/delete_set.php
declare(strict_types=1);

require __DIR__ . "/_lib.php";

$uid = user_id();
$data = read_json_body();
require_keys($data, ["set_id"]);

$setId = intv($data["set_id"], 1);

$cur = $pdo->prepare("SELECT id, workout_id FROM workout_sets WHERE id = ? AND user_id = ? LIMIT 1");
$cur->execute([$setId, $uid]);
$row = $cur->fetch(PDO::FETCH_ASSOC);
if (!$row) json_err("Set not found", 404);

$wid = (int)$row["workout_id"];

$del = $pdo->prepare("DELETE FROM workout_sets WHERE id = ? AND user_id = ?");
$del->execute([$setId, $uid]);

$now = now_sql();
$touch = $pdo->prepare("UPDATE workouts SET updated_at = ? WHERE id = ? AND user_id = ?");
$touch->execute([$now, $wid, $uid]);

json_ok([
  "deleted" => true,
  "summary" => workout_summary($pdo, $wid),
]);
