<?php
// api/workout/update_set.php
declare(strict_types=1);

require __DIR__ . "/_lib.php";

$uid = user_id();
$data = read_json_body();
require_keys($data, ["set_id"]);

$setId = intv($data["set_id"], 1);
$reps = array_key_exists("reps", $data) ? intv($data["reps"], 1, 1000) : null;
$load = array_key_exists("load_lbs", $data) ? nullable_float($data["load_lbs"]) : null;
$stim = array_key_exists("stimulus", $data) ? floatv($data["stimulus"], 0.0, 5.0) : null;

$musclesJson = null;
$clean = null;
if (array_key_exists("muscles", $data)) {
  if (!is_array($data["muscles"])) json_err("muscles must be an object map");
  $clean = [];
  foreach ($data["muscles"] as $k => $v) {
    $gid = strv($k);
    if ($gid === "") continue;
    if (!is_numeric($v)) continue;
    $w = (float)$v;
    if (!is_finite($w) || $w <= 0) continue;
    $clean[$gid] = $w;
  }
  $musclesJson = json_encode($clean, JSON_UNESCAPED_SLASHES);
  if ($musclesJson === false) $musclesJson = null;
}

$now = now_sql();

$cur = $pdo->prepare("
  SELECT ws.id, ws.workout_id, w.ended_at
  FROM workout_sets ws
  JOIN workouts w ON w.id = ws.workout_id
  WHERE ws.id = ? AND ws.user_id = ?
  LIMIT 1
");
$cur->execute([$setId, $uid]);
$row = $cur->fetch(PDO::FETCH_ASSOC);
if (!$row) json_err("Set not found", 404);

if ($row["ended_at"] !== null) {
  // Allow editing ended workouts? If you want to block it, keep this. If you want allow, delete this.
  // For now: allow edits (you asked to click old workouts and change them).
}

$fields = [];
$params = [];

if ($reps !== null) { $fields[] = "reps = ?"; $params[] = $reps; }
if (array_key_exists("load_lbs", $data)) { $fields[] = "load_lbs = ?"; $params[] = $load; }
if ($stim !== null) { $fields[] = "stimulus = ?"; $params[] = $stim; }
if (array_key_exists("muscles", $data)) { $fields[] = "muscles_json = ?"; $params[] = $musclesJson; }

if (!$fields) json_err("No fields to update");

$fields[] = "updated_at = ?";
$params[] = $now;

$params[] = $setId;
$params[] = $uid;

$sql = "UPDATE workout_sets SET " . implode(", ", $fields) . " WHERE id = ? AND user_id = ?";
$upd = $pdo->prepare($sql);
$upd->execute($params);

$wid = (int)$row["workout_id"];
$touch = $pdo->prepare("UPDATE workouts SET updated_at = ? WHERE id = ? AND user_id = ?");
$touch->execute([$now, $wid, $uid]);

json_ok([
  "updated" => true,
  "summary" => workout_summary($pdo, $wid),
]);
