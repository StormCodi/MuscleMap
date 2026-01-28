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
  $stmt = $pdo->prepare("SELECT id, password_hash FROM users WHERE email = ? LIMIT 1");
  $stmt->execute([$email]);
  $row = $stmt->fetch(PDO::FETCH_ASSOC);

  if (!$row) bad("invalid_credentials", 401);

  $uid = (int)$row["id"];
  $hash = (string)$row["password_hash"];

  if ($uid <= 0 || $hash === "" || !password_verify($pass, $hash)) {
    bad("invalid_credentials", 401);
  }

  $_SESSION["user_id"] = $uid;

  # optional: mitigate fixation
  @session_regenerate_id(true);

  echo json_encode(["ok" => true, "user_id" => $uid], JSON_UNESCAPED_SLASHES);
} catch (Throwable $e) {
  bad("server_error", 500);
}
