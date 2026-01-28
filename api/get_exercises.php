<?php
// api/get_exercises.php
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

try {
  // Compatibility: old frontend may call get_exercises.php.
  // New canonical source is: exercises (user_id + exercise_key + weights_json + is_active)
  $stmt = $pdo->prepare("
    SELECT exercise_key AS id, name, weights_json
    FROM exercises
    WHERE user_id = :uid AND is_active = 1
    ORDER BY name ASC
  ");
  $stmt->execute([":uid" => $uid]);

  $out = [];
  foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
    $w = json_decode((string)($r["weights_json"] ?? ""), true);
    if (!is_array($w)) $w = [];
    $out[] = [
      "id" => (string)($r["id"] ?? ""),
      "name" => (string)($r["name"] ?? ""),
      "w" => $w,
    ];
  }

  echo json_encode(["ok" => true, "exercises" => $out], JSON_UNESCAPED_SLASHES);
} catch (Throwable $e) {
  fail("server_error", 500);
}
