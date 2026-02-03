<?php
// api/workout/update_set.php
declare(strict_types=1);

require __DIR__ . "/_lib.php";

$uid = user_id();
$data = read_json_body();

$setId = array_key_exists("set_id", $data) ? (int)$data["set_id"] : 0;
if ($setId <= 0) json_err("bad_set_id", 400);

$fields = [];
$args = [];

if (array_key_exists("reps", $data)) {
  $reps = intv($data["reps"], 1, 1000);
  $fields[] = "reps = ?";
  $args[] = $reps;
}
if (array_key_exists("load_lbs", $data)) {
  $load = nullable_float($data["load_lbs"]);
  if ($load !== null && $load < 0) $load = 0.0;
  $fields[] = "load_lbs = ?";
  $args[] = $load;
}
if (array_key_exists("stimulus", $data)) {
  $stim = floatv($data["stimulus"], 0.0, 5.0);
  $fields[] = "stimulus = ?";
  $args[] = $stim;
}
if (array_key_exists("completed", $data)) {
  $completed = $data["completed"] ? 1 : 0;
  $fields[] = "completed = ?";
  $args[] = $completed;
}
if (array_key_exists("muscles", $data)) {
  // optional: allow update muscles map
  $muscles = $data["muscles"];
  if (!is_array($muscles)) json_err("muscles must be an object map", 400);

  $clean = [];
  foreach ($muscles as $k => $v) {
    $gid = strv($k);
    if ($gid === "") continue;
    if (!is_numeric($v)) continue;
    $w = (float)$v;
    if (!is_finite($w) || $w <= 0) continue;
    $clean[$gid] = $w;
  }

  $musclesJson = json_encode($clean, JSON_UNESCAPED_SLASHES);
  if ($musclesJson === false) $musclesJson = null;

  $fields[] = "muscles_json = ?";
  $args[] = $musclesJson;
}

if (!$fields) json_err("no_fields", 400);

$now = now_sql();
$fields[] = "updated_at = ?";
$args[] = $now;

$args[] = $setId;
$args[] = $uid;

$sql = "UPDATE workout_sets SET " . implode(", ", $fields) . " WHERE id = ? AND user_id = ?";
$upd = $pdo->prepare($sql);
$upd->execute($args);

if ($upd->rowCount() <= 0) {
  json_err("not_found", 404);
}

// need summary => find workout_id
$st = $pdo->prepare("SELECT workout_id FROM workout_sets WHERE id = ? AND user_id = ?");
$st->execute([$setId, $uid]);
$row = $st->fetch(PDO::FETCH_ASSOC);
$wid = $row ? (int)$row["workout_id"] : 0;

if ($wid > 0) {
  $touch = $pdo->prepare("UPDATE workouts SET updated_at = ? WHERE id = ? AND user_id = ?");
  $touch->execute([$now, $wid, $uid]);
}

json_ok([
  "updated" => true,
  "summary" => $wid > 0 ? workout_summary($pdo, $wid) : null,
]);
