<?php
declare(strict_types=1);

require __DIR__ . "/../db.php";
header("Content-Type: application/json; charset=utf-8");

function bad(string $msg, int $code = 400, array $extra = []): void {
  http_response_code($code);
  echo json_encode(["ok" => false, "error" => $msg] + $extra, JSON_UNESCAPED_SLASHES);
  exit;
}

$raw = file_get_contents("php://input");
$data = json_decode($raw ?: "", true);
if (!is_array($data)) bad("bad_json");

$email = strtolower(trim((string)($data["email"] ?? "")));
$pass  = (string)($data["password"] ?? "");

if ($email === "" || !filter_var($email, FILTER_VALIDATE_EMAIL)) bad("bad_email");
if ($pass === "" || strlen($pass) < 6) bad("bad_password");

try {
  // Assumes: users(email UNIQUE), users(password_hash), users(id PK)
  $hash = password_hash($pass, PASSWORD_DEFAULT);
  if (!$hash) bad("hash_fail", 500);

  $stmt = $pdo->prepare("
    INSERT INTO users (email, password_hash)
    VALUES (?, ?)
  ");
  $stmt->execute([$email, $hash]);

  $uid = (int)$pdo->lastInsertId();
  if ($uid <= 0) bad("register_failed", 500);

  $_SESSION["user_id"] = $uid;
  @session_regenerate_id(true);

  echo json_encode(["ok" => true, "user_id" => $uid], JSON_UNESCAPED_SLASHES);
} catch (Throwable $e) {
  // Duplicate email (common SQLSTATE for unique constraint)
  $sqlState = (string)($e->getCode() ?? "");
  if ($sqlState === "23000") {
    bad("email_taken", 409);
  }
  bad("server_error", 500);
}
