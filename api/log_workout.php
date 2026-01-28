<?php
// api/log_workout.php
declare(strict_types=1);

/**
 * Legacy endpoint compatibility.
 * Old payload: {date, exercise_id, exercise_name, sets, reps, stimulus, muscles, load_lbs?}
 *
 * New behavior:
 * - Requires login (account-based).
 * - If there's an active workout, appends N set rows to it.
 * - If not, creates a "one-off" workout anchored to the given date, inserts sets, closes it.
 */

require __DIR__ . "/workout/_lib.php";

header("Content-Type: application/json; charset=utf-8");

function fail(string $msg, int $code = 400, array $extra = []): void {
  http_response_code($code);
  echo json_encode(["ok" => false, "error" => $msg] + $extra, JSON_UNESCAPED_SLASHES);
  exit;
}

$uid = user_id();

$raw = file_get_contents("php://input");
$data = json_decode($raw ?: "", true);
if (!is_array($data)) fail("bad_json");

$required = ["date","exercise_id","exercise_name","sets","reps","stimulus","muscles"];
foreach ($required as $k) {
  if (!array_key_exists($k, $data)) fail("missing_" . $k);
}

$date          = trim((string)$data["date"]);
$exercise_id   = trim((string)$data["exercise_id"]);
$exercise_name = trim((string)$data["exercise_name"]);
$sets          = (int)$data["sets"];
$reps          = (int)$data["reps"];
$stimulus      = (float)$data["stimulus"];
$load_lbs      = array_key_exists("load_lbs", $data) && $data["load_lbs"] !== null ? (float)$data["load_lbs"] : null;

if ($exercise_id === "" || $exercise_name === "") fail("bad_exercise");
if ($sets < 1 || $sets > 200) fail("bad_sets");
if ($reps < 1 || $reps > 1000) fail("bad_reps");
if (!is_finite($stimulus) || $stimulus < 0.0 || $stimulus > 5.0) fail("bad_stimulus");

$muscles = $data["muscles"];
if (!is_array($muscles)) fail("bad_muscles");

// sanitize muscles: keep finite positive weights
$clean = [];
foreach ($muscles as $k => $v) {
  $gid = trim((string)$k);
  if ($gid === "") continue;
  if (!is_numeric($v)) continue;
  $w = (float)$v;
  if (!is_finite($w) || $w <= 0) continue;
  $clean[$gid] = $w;
}
$musclesJson = json_encode($clean, JSON_UNESCAPED_SLASHES);
if ($musclesJson === false) $musclesJson = null;

// Anchor timestamp from "date"
$startAt = null;
if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
  $startAt = $date . " 12:00:00";
} elseif (preg_match('/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/', $date)) {
  $startAt = str_replace("T", " ", substr($date, 0, 19));
} else {
  fail("bad_date");
}

try {
  $pdo->beginTransaction();

  $active = get_active_workout($pdo, $uid);
  $wid = 0;
  $createdWorkout = false;

  if ($active) {
    $wid = (int)$active["id"];
  } else {
    // create one-off workout and close later
    $insW = $pdo->prepare("
      INSERT INTO workouts (user_id, started_at, ended_at, auto_closed, created_at, updated_at)
      VALUES (?, ?, NULL, 0, ?, ?)
    ");
    $insW->execute([$uid, $startAt, $startAt, $startAt]);
    $wid = (int)$pdo->lastInsertId();
    if ($wid <= 0) throw new RuntimeException("workout_create_failed");
    $createdWorkout = true;
  }

  // Insert N set rows
  $insS = $pdo->prepare("
    INSERT INTO workout_sets
      (workout_id, user_id, exercise_id, exercise_name, reps, load_lbs, stimulus, muscles_json, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ");

  for ($i = 0; $i < $sets; $i++) {
    // tiny offsets so ordering is stable
    $t = date("Y-m-d H:i:s", strtotime($startAt) + $i);
    $insS->execute([
      $wid, $uid,
      $exercise_id, $exercise_name,
      $reps, $load_lbs,
      $stimulus, $musclesJson,
      $t, $t
    ]);
  }

  // Touch workout updated_at, and if we created it, close it
  $endAt = date("Y-m-d H:i:s", strtotime($startAt) + max(1, $sets));
  if ($createdWorkout) {
    $updW = $pdo->prepare("
      UPDATE workouts
      SET ended_at = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    ");
    $updW->execute([$endAt, $endAt, $wid, $uid]);
  } else {
    $updW = $pdo->prepare("UPDATE workouts SET updated_at = ? WHERE id = ? AND user_id = ?");
    $updW->execute([now_sql(), $wid, $uid]);
  }

  $pdo->commit();

  echo json_encode([
    "ok" => true,
    "workout_id" => $wid,
    "inserted_sets" => $sets,
    "summary" => workout_summary($pdo, $wid),
  ], JSON_UNESCAPED_SLASHES);
} catch (Throwable $e) {
  if ($pdo->inTransaction()) $pdo->rollBack();
  fail("server_error", 500);
}
