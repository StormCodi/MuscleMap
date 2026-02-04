<?php
// api/workout/get_last_sets_for_exercise.php
declare(strict_types=1);

require __DIR__ . "/_lib.php";

$uid = user_id();

$exerciseId = isset($_GET["exercise_id"]) ? strv($_GET["exercise_id"]) : "";
if ($exerciseId === "") json_err("missing_exercise_id", 400);

$lastCompletedOnly = isset($_GET["last_completed_only"]) ? ((int)$_GET["last_completed_only"] ? 1 : 0) : 0;

// If there is an active workout, exclude it so we only “look back”
$active = get_active_workout($pdo, $uid);
$activeId = $active ? (int)$active["id"] : 0;

/**
 * NEW:
 * - Always compute the most recent COMPLETED set for this exercise (across ALL workouts),
 *   excluding the current active workout (so “no matter what workout”).
 * - Optional mode: ?last_completed_only=1 returns ONLY last_completed_set.
 */
$lastCompletedSet = null;
if ($activeId > 0) {
  $stmtLC = $pdo->prepare("
    SELECT
      id, workout_id, exercise_id, exercise_name, reps, load_lbs, stimulus, completed, muscles_json, created_at, updated_at
    FROM workout_sets
    WHERE user_id = ?
      AND exercise_id = ?
      AND completed = 1
      AND workout_id <> ?
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  ");
  $stmtLC->execute([$uid, $exerciseId, $activeId]);
} else {
  $stmtLC = $pdo->prepare("
    SELECT
      id, workout_id, exercise_id, exercise_name, reps, load_lbs, stimulus, completed, muscles_json, created_at, updated_at
    FROM workout_sets
    WHERE user_id = ?
      AND exercise_id = ?
      AND completed = 1
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  ");
  $stmtLC->execute([$uid, $exerciseId]);
}

$rowLC = $stmtLC->fetch(PDO::FETCH_ASSOC);
if ($rowLC) {
  $muscles = [];
  $mj = (string)($rowLC["muscles_json"] ?? "");
  if ($mj !== "") {
    $decoded = json_decode($mj, true);
    if (is_array($decoded)) $muscles = $decoded;
  }

  $lastCompletedSet = [
    "id" => (int)$rowLC["id"],
    "workout_id" => (int)$rowLC["workout_id"],
    "exercise_id" => (string)$rowLC["exercise_id"],
    "exercise_name" => (string)$rowLC["exercise_name"],
    "reps" => (int)$rowLC["reps"],
    "load_lbs" => ($rowLC["load_lbs"] === null ? null : (float)$rowLC["load_lbs"]),
    "stimulus" => ($rowLC["stimulus"] === null ? 0.0 : (float)$rowLC["stimulus"]),
    "completed" => ((int)$rowLC["completed"] ? 1 : 0),
    "muscles" => $muscles,
    "created_at" => (string)$rowLC["created_at"],
    "updated_at" => (string)$rowLC["updated_at"],
  ];
}

if ($lastCompletedOnly) {
  json_ok([
    "workout_id" => null,
    "sets" => [],
    "last_completed_set" => $lastCompletedSet,
  ]);
}

/**
 * Existing behavior preserved:
 * Find the most recent workout (excluding current active) that contains at least
 * one set for this exercise_id, then return the sets for that exercise from
 * that workout, in ascending id order, capped to 20.
 */
if ($activeId > 0) {
  $stmt = $pdo->prepare("
    SELECT w.id
    FROM workouts w
    JOIN workout_sets s ON s.workout_id = w.id
    WHERE w.user_id = ?
      AND w.id <> ?
      AND s.user_id = ?
      AND s.exercise_id = ?
    ORDER BY w.started_at DESC, w.id DESC
    LIMIT 1
  ");
  $stmt->execute([$uid, $activeId, $uid, $exerciseId]);
} else {
  $stmt = $pdo->prepare("
    SELECT w.id
    FROM workouts w
    JOIN workout_sets s ON s.workout_id = w.id
    WHERE w.user_id = ?
      AND s.user_id = ?
      AND s.exercise_id = ?
    ORDER BY w.started_at DESC, w.id DESC
    LIMIT 1
  ");
  $stmt->execute([$uid, $uid, $exerciseId]);
}

$lastWid = (int)($stmt->fetchColumn() ?: 0);
if ($lastWid <= 0) {
  json_ok([
    "workout_id" => null,
    "sets" => [],
    "last_completed_set" => $lastCompletedSet,
  ]);
}

$setsStmt = $pdo->prepare("
  SELECT
    id,
    workout_id,
    exercise_id,
    exercise_name,
    reps,
    load_lbs,
    stimulus,
    completed,
    muscles_json,
    created_at,
    updated_at
  FROM workout_sets
  WHERE user_id = ?
    AND workout_id = ?
    AND exercise_id = ?
  ORDER BY id ASC
  LIMIT 20
");
$setsStmt->execute([$uid, $lastWid, $exerciseId]);

$out = [];
while ($row = $setsStmt->fetch(PDO::FETCH_ASSOC)) {
  $muscles = [];
  $mj = (string)($row["muscles_json"] ?? "");
  if ($mj !== "") {
    $decoded = json_decode($mj, true);
    if (is_array($decoded)) $muscles = $decoded;
  }

  $out[] = [
    "id" => (int)$row["id"],
    "workout_id" => (int)$row["workout_id"],
    "exercise_id" => (string)$row["exercise_id"],
    "exercise_name" => (string)$row["exercise_name"],
    "reps" => (int)$row["reps"],
    "load_lbs" => ($row["load_lbs"] === null ? null : (float)$row["load_lbs"]),
    "stimulus" => ($row["stimulus"] === null ? 0.0 : (float)$row["stimulus"]),
    "completed" => ((int)$row["completed"] ? 1 : 0),
    "muscles" => $muscles,
    "created_at" => (string)$row["created_at"],
    "updated_at" => (string)$row["updated_at"],
  ];
}

json_ok([
  "workout_id" => $lastWid,
  "sets" => $out,
  "last_completed_set" => $lastCompletedSet,
]);
