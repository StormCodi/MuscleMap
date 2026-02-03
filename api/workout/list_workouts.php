<?php
// api/workout/list_workouts.php
declare(strict_types=1);

require __DIR__ . "/_lib.php";

$uid = user_id();

$page = isset($_GET["page"]) ? (int)$_GET["page"] : 1;
$per  = isset($_GET["per"])  ? (int)$_GET["per"]  : 5;

if ($page < 1) $page = 1;
if ($per < 1) $per = 5;
if ($per > 50) $per = 50;

$offset = ($page - 1) * $per;

try {
  // COUNT must match the same filter as the listing query,
  // otherwise pagination will be inconsistent.
  $stTotal = $pdo->prepare("
    SELECT COUNT(*) AS c
    FROM workouts w
    WHERE w.user_id = ?
      AND EXISTS (
        SELECT 1
        FROM workout_sets ws
        WHERE ws.workout_id = w.id
          AND ws.user_id = ?
      )
  ");
  $stTotal->execute([$uid, $uid]);
  $total = (int)($stTotal->fetch(PDO::FETCH_ASSOC)["c"] ?? 0);

  $pages = max(1, (int)ceil($total / max(1, $per)));

  // clamp page into range now that total is correct
  if ($page > $pages) {
    $page = $pages;
    $offset = ($page - 1) * $per;
  }

  // workouts list (newest first) - same filter as COUNT
  $st = $pdo->prepare("
    SELECT w.id, w.user_id, w.started_at, w.ended_at, w.auto_closed, w.created_at, w.updated_at
    FROM workouts w
    WHERE w.user_id = ?
      AND EXISTS (
        SELECT 1
        FROM workout_sets ws
        WHERE ws.workout_id = w.id
          AND ws.user_id = ?
      )
    ORDER BY w.started_at DESC, w.id DESC
    LIMIT ? OFFSET ?
  ");
  $st->bindValue(1, $uid, PDO::PARAM_INT);
  $st->bindValue(2, $uid, PDO::PARAM_INT);
  $st->bindValue(3, $per, PDO::PARAM_INT);
  $st->bindValue(4, $offset, PDO::PARAM_INT);
  $st->execute();

  $workouts = $st->fetchAll(PDO::FETCH_ASSOC);

  if (!$workouts) {
    json_ok([
      "page" => $page,
      "pages" => $pages,
      "per" => $per,
      "total" => $total,
      "workouts" => [],
    ]);
  }

  // summaries for workouts on this page
  $ids = array_values(array_filter(array_map(fn($w) => (int)$w["id"], $workouts), fn($x) => $x > 0));
  $sumById = [];

  if ($ids) {
    $in = implode(",", array_fill(0, count($ids), "?"));
    $stSum = $pdo->prepare("
      SELECT
        workout_id,
        COUNT(*) AS sets_count,
        COUNT(DISTINCT exercise_id) AS exercises_count
      FROM workout_sets
      WHERE user_id = ? AND workout_id IN ($in)
      GROUP BY workout_id
    ");
    $stSum->execute(array_merge([$uid], $ids));

    foreach ($stSum->fetchAll(PDO::FETCH_ASSOC) as $r) {
      $wid = (int)$r["workout_id"];
      $sumById[$wid] = [
        "sets_count" => (int)$r["sets_count"],
        "exercises_count" => (int)$r["exercises_count"],
      ];
    }
  }

  foreach ($workouts as &$w) {
    $wid = (int)$w["id"];
    $w["summary"] = $sumById[$wid] ?? ["sets_count" => 0, "exercises_count" => 0];
  }
  unset($w);

  json_ok([
    "page" => $page,
    "pages" => $pages,
    "per" => $per,
    "total" => $total,
    "workouts" => $workouts,
  ]);
} catch (Throwable $e) {
  json_err("Failed to list workouts: " . $e->getMessage(), 500);
}
