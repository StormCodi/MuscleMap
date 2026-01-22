<?php
// api/ai_intake_start.php
declare(strict_types=1);
require __DIR__ . "/db.php";
header("Content-Type: application/json; charset=utf-8");

try {
  $stmt = $pdo->prepare("INSERT INTO ai_intake_sessions (user_id,status) VALUES (?, 'open')");
  $stmt->execute([GLOBAL_USER_ID]);
  $id = (int)$pdo->lastInsertId();

  echo json_encode(["ok" => true, "session_id" => $id]);
} catch (Throwable $e) {
  http_response_code(500);
  echo json_encode(["ok" => false, "error" => "server_error"]);
}
