<?php
// api/exercise_prefs.php
declare(strict_types=1);

require __DIR__ . "/db.php";

$uid = require_user_id();
$method = $_SERVER["REQUEST_METHOD"] ?? "GET";


function read_json_body(): array {
  $raw = file_get_contents("php://input");
  $data = json_decode($raw ?: "{}", true);
  if (!is_array($data)) json_err("bad_json", 400);
  return $data;
}
function strv(mixed $v): string {
  return is_string($v) ? trim($v) : trim((string)$v);
}
function now_sql(): string {
  return date("Y-m-d H:i:s");
}
function clean_prefs(array $prefs): array {
  // allowlist keys to keep it stable for later expansions
  $out = [];

  if (array_key_exists("timer_enabled", $prefs)) {
    $out["timer_enabled"] = (bool)$prefs["timer_enabled"];
  }
  if (array_key_exists("timer_secs", $prefs)) {
    $secs = (int)$prefs["timer_secs"];
    // clamp: 0..3600 (0 means irrelevant if disabled)
    if ($secs < 0) $secs = 0;
    if ($secs > 3600) $secs = 3600;
    $out["timer_secs"] = $secs;
  }

  // Phase 4 will add: default_reps, default_load_lbs, last_sets_count, etc.

  return $out;
}

if ($method === "GET") {
  // return all prefs map for user: { map: { exercise_key: { ...prefs } } }
  $stmt = $pdo->prepare("SELECT exercise_key, prefs_json FROM exercise_prefs WHERE user_id = ?");
  $stmt->execute([$uid]);

  $map = [];
  while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
    $k = (string)$row["exercise_key"];
    $pj = (string)$row["prefs_json"];
    $prefs = json_decode($pj ?: "{}", true);
    if (!is_array($prefs)) $prefs = [];
    $map[$k] = $prefs;
  }

  json_ok(["map" => $map]);
}

if ($method === "POST") {
  $data = read_json_body();

  // Accept either:
  //  A) { exercise_key: "bench_press", prefs: {timer_enabled: true, timer_secs: 60} }
  //  B) { map: { "bench_press": { ... }, "lat_pulldown": { ... } } }
  $now = now_sql();

  if (isset($data["map"]) && is_array($data["map"])) {
    $saved = 0;
    foreach ($data["map"] as $k => $prefs) {
      $exerciseKey = strv($k);
      if ($exerciseKey === "" || strlen($exerciseKey) > 64) continue;
      if (!is_array($prefs)) continue;

      $clean = clean_prefs($prefs);
      $json = json_encode($clean, JSON_UNESCAPED_SLASHES);
      if ($json === false) continue;

      $stmt = $pdo->prepare("
        INSERT INTO exercise_prefs (user_id, exercise_key, prefs_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE prefs_json = VALUES(prefs_json), updated_at = VALUES(updated_at)
      ");
      $stmt->execute([$uid, $exerciseKey, $json, $now]);
      $saved++;
    }

    json_ok(["saved" => $saved]);
  }

  $exerciseKey = isset($data["exercise_key"]) ? strv($data["exercise_key"]) : "";
  $prefs = $data["prefs"] ?? null;
  if ($exerciseKey === "" || strlen($exerciseKey) > 64) json_err("missing_or_bad_exercise_key", 400);
  if (!is_array($prefs)) json_err("missing_prefs_object", 400);

  $clean = clean_prefs($prefs);
  $json = json_encode($clean, JSON_UNESCAPED_SLASHES);
  if ($json === false) json_err("json_encode_failed", 500);

  $stmt = $pdo->prepare("
    INSERT INTO exercise_prefs (user_id, exercise_key, prefs_json, updated_at)
    VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE prefs_json = VALUES(prefs_json), updated_at = VALUES(updated_at)
  ");
  $stmt->execute([$uid, $exerciseKey, $json, $now]);

  json_ok(["saved" => 1]);
}

json_err("method_not_allowed", 405);
