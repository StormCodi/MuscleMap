<?php
// api/workout/_lib.php
declare(strict_types=1);

require __DIR__ . "/../db.php";

/* =========================
   JSON helpers
========================= */

function json_ok(array $data = []): void {
  header("Content-Type: application/json; charset=utf-8");
  echo json_encode(["ok" => true] + $data, JSON_UNESCAPED_SLASHES);
  exit;
}

function json_err(string $msg, int $code = 400, array $extra = []): void {
  header("Content-Type: application/json; charset=utf-8");
  http_response_code($code);
  echo json_encode(["ok" => false, "error" => $msg] + $extra, JSON_UNESCAPED_SLASHES);
  exit;
}

function read_json_body(): array {
  $raw = file_get_contents("php://input");
  $data = json_decode($raw ?: "", true);
  if (!is_array($data)) json_err("Invalid JSON");
  return $data;
}

function require_keys(array $data, array $keys): void {
  foreach ($keys as $k) {
    if (!array_key_exists($k, $data)) json_err("Missing $k");
  }
}

function strv($v): string {
  return trim((string)$v);
}

function intv($v, int $min = PHP_INT_MIN, int $max = PHP_INT_MAX): int {
  if (!is_numeric($v)) json_err("Expected integer");
  $i = (int)$v;
  if ($i < $min || $i > $max) json_err("Integer out of range");
  return $i;
}

function floatv($v, float $min = -INF, float $max = INF): float {
  if (!is_numeric($v)) json_err("Expected number");
  $f = (float)$v;
  if (!is_finite($f) || $f < $min || $f > $max) json_err("Number out of range");
  return $f;
}

function nullable_float($v): ?float {
  if ($v === null) return null;
  if ($v === "") return null;
  return floatv($v);
}

function now_sql(): string {
  return date("Y-m-d H:i:s");
}

function user_id(): int {
  // uses your existing GLOBAL_USER_ID constant from api/db.php
  return defined("GLOBAL_USER_ID") ? (int)GLOBAL_USER_ID : 0;
}

/* =========================
   Workout helpers
========================= */

// 5 hour autoclose window
const WORKOUT_AUTOCLOSE_SECONDS = 5 * 60 * 60;

function autoclose_if_needed(PDO $pdo, int $uid): void {
  // close any "active" workout older than 5 hours
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
  // totals for UI
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
