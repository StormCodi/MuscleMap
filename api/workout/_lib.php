<?php
// api/workout/_lib.php
declare(strict_types=1);

require __DIR__ . "/../db.php";

/**
 * Enforce login for every workout endpoint that includes this file.
 * Also centralize helpers used by workout endpoints.
 */
$MM_UID = require_user_id();
$GLOBALS["MM_UID"] = $MM_UID;

/* =========================
   JSON helpers
========================= */

if (!function_exists("mm_json_ok")) {
  function mm_json_ok(array $data = []): void {
    header("Content-Type: application/json; charset=utf-8");
    echo json_encode(["ok" => true] + $data, JSON_UNESCAPED_SLASHES);
    exit;
  }
}

if (!function_exists("mm_json_err")) {
  function mm_json_err(string $msg, int $code = 400, array $extra = []): void {
    header("Content-Type: application/json; charset=utf-8");
    http_response_code($code);
    echo json_encode(["ok" => false, "error" => $msg] + $extra, JSON_UNESCAPED_SLASHES);
    exit;
  }
}

if (!function_exists("mm_read_json_body")) {
  function mm_read_json_body(): array {
    $raw = file_get_contents("php://input");
    $data = json_decode($raw ?: "", true);
    if (!is_array($data)) mm_json_err("bad_json", 400);
    return $data;
  }
}

if (!function_exists("mm_require_keys")) {
  function mm_require_keys(array $data, array $keys): void {
    foreach ($keys as $k) {
      if (!array_key_exists($k, $data)) mm_json_err("missing_" . $k, 400);
    }
  }
}

if (!function_exists("mm_strv")) {
  function mm_strv($v): string {
    return trim((string)$v);
  }
}

if (!function_exists("mm_intv")) {
  function mm_intv($v, int $min = PHP_INT_MIN, int $max = PHP_INT_MAX): int {
    if (!is_numeric($v)) mm_json_err("expected_int", 400);
    $i = (int)$v;
    if ($i < $min || $i > $max) mm_json_err("int_out_of_range", 400);
    return $i;
  }
}

if (!function_exists("mm_floatv")) {
  function mm_floatv($v, float $min = -INF, float $max = INF): float {
    if (!is_numeric($v)) mm_json_err("expected_number", 400);
    $f = (float)$v;
    if (!is_finite($f) || $f < $min || $f > $max) mm_json_err("number_out_of_range", 400);
    return $f;
  }
}

if (!function_exists("mm_nullable_float")) {
  function mm_nullable_float($v): ?float {
    if ($v === null || $v === "") return null;
    return mm_floatv($v);
  }
}

if (!function_exists("mm_now_sql")) {
  function mm_now_sql(): string {
    return date("Y-m-d H:i:s");
  }
}

/* =========================
   Back-compat aliases (older workout endpoints may call these)
   We only define them if they don't already exist.
========================= */

if (!function_exists("json_ok")) {
  function json_ok(array $data = []): void { mm_json_ok($data); }
}
if (!function_exists("json_err")) {
  function json_err(string $msg, int $code = 400, array $extra = []): void { mm_json_err($msg, $code, $extra); }
}
if (!function_exists("read_json_body")) {
  function read_json_body(): array { return mm_read_json_body(); }
}
if (!function_exists("require_keys")) {
  function require_keys(array $data, array $keys): void { mm_require_keys($data, $keys); }
}
if (!function_exists("strv")) {
  function strv($v): string { return mm_strv($v); }
}
if (!function_exists("intv")) {
  function intv($v, int $min = PHP_INT_MIN, int $max = PHP_INT_MAX): int { return mm_intv($v, $min, $max); }
}
if (!function_exists("floatv")) {
  function floatv($v, float $min = -INF, float $max = INF): float { return mm_floatv($v, $min, $max); }
}
if (!function_exists("nullable_float")) {
  function nullable_float($v): ?float { return mm_nullable_float($v); }
}
if (!function_exists("now_sql")) {
  function now_sql(): string { return mm_now_sql(); }
}

/* =========================
   User context (ACCOUNT-BASED)
========================= */

function user_id(): int {
  $uid = (int)($GLOBALS["MM_UID"] ?? 0);
  if ($uid <= 0) mm_json_err("unauthorized", 401);
  return $uid;
}

/* =========================
   Workout helpers
========================= */

// 5 hour autoclose window
const WORKOUT_AUTOCLOSE_SECONDS = 5 * 60 * 60;

function autoclose_if_needed(PDO $pdo, int $uid): void {
  $stmt = $pdo->prepare("
    SELECT id, started_at
    FROM workouts
    WHERE user_id = ? AND ended_at IS NULL
    ORDER BY started_at DESC
    LIMIT 1
  ");
  $stmt->execute([$uid]);
  $w = $stmt->fetch(PDO::FETCH_ASSOC);
  if (!$w) return;

  $startedAt = strtotime((string)$w["started_at"]);
  if (!$startedAt) return;

  $age = time() - $startedAt;
  if ($age < WORKOUT_AUTOCLOSE_SECONDS) return;

  $end = date("Y-m-d H:i:s");
  $upd = $pdo->prepare("
    UPDATE workouts
    SET ended_at = ?, auto_closed = 1
    WHERE id = ? AND user_id = ? AND ended_at IS NULL
  ");
  $upd->execute([$end, (int)$w["id"], $uid]);
}

function get_active_workout(PDO $pdo, int $uid): ?array {
  autoclose_if_needed($pdo, $uid);

  $stmt = $pdo->prepare("
    SELECT id, user_id, started_at, ended_at, auto_closed
    FROM workouts
    WHERE user_id = ? AND ended_at IS NULL
    ORDER BY started_at DESC
    LIMIT 1
  ");
  $stmt->execute([$uid]);
  $w = $stmt->fetch(PDO::FETCH_ASSOC);
  return $w ?: null;
}

function workout_summary(PDO $pdo, int $workoutId): array {
  $stmt = $pdo->prepare("
    SELECT
      COUNT(*) as sets_count,
      COUNT(DISTINCT exercise_id) as exercises_count,
      COALESCE(SUM(reps),0) as total_reps
    FROM workout_sets
    WHERE workout_id = ?
  ");
  $stmt->execute([$workoutId]);
  $r = $stmt->fetch(PDO::FETCH_ASSOC) ?: ["sets_count"=>0,"exercises_count"=>0,"total_reps"=>0];

  return [
    "sets_count" => (int)$r["sets_count"],
    "exercises_count" => (int)$r["exercises_count"],
    "total_reps" => (int)$r["total_reps"],
  ];
}
