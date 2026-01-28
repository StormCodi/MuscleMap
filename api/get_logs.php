<?php
// api/get_logs.php
declare(strict_types=1);

require __DIR__ . "/db.php";
header("Content-Type: application/json; charset=utf-8");

// Enforce login
$uid = require_user_id();

function fail(string $msg, int $code = 400, array $extra = []): void {
  http_response_code($code);
  echo json_encode(["ok" => false, "error" => $msg] + $extra, JSON_UNESCAPED_SLASHES);
  exit;
}

$limit = 250;
if (isset($_GET["limit"])) {
  $v = $_GET["limit"];
  if (!is_numeric($v)) fail("bad_limit");
  $limit = (int)$v;
}
if ($limit < 1) $limit = 1;
if ($limit > 500) $limit = 500;

try {
  // LIMIT can't be bound reliably in all PDO configs; validate and inline as int.
  $sql = "
    SELECT
      id,
      workout_date,
      exercise_id,
      exercise_name,
      sets,
      reps,
      load_lbs,
      stimulus,
      created_at,
      muscles_json
    FROM workout_logs
    WHERE user_id = ?
    ORDER BY workout_date DESC, id DESC
    LIMIT {$limit}
  ";

  $stmt = $pdo->prepare($sql);
  $stmt->execute([$uid]);

  echo json_encode([
    "ok" => true,
    "rows" => $stmt->fetchAll(PDO::FETCH_ASSOC),
  ], JSON_UNESCAPED_SLASHES);
} catch (Throwable $e) {
  fail("server_error", 500);
}
