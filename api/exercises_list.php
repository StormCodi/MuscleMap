<?php
// api/exercises_list.php
declare(strict_types=1);
require __DIR__ . "/db.php";
header("Content-Type: application/json; charset=utf-8");

try {
  $stmt = $pdo->prepare("
    SELECT exercise_key AS id, name, weights_json
    FROM exercises
    WHERE user_id = :uid AND is_active = 1
    ORDER BY name ASC
  ");
  $stmt->execute([":uid" => GLOBAL_USER_ID]);

  $out = [];
  foreach ($stmt->fetchAll() as $r) {
    $w = json_decode((string)$r["weights_json"], true);
    if (!is_array($w)) $w = [];
    $out[] = ["id" => (string)$r["id"], "name" => (string)$r["name"], "w" => $w];
  }

  echo json_encode(["ok" => true, "exercises" => $out], JSON_UNESCAPED_SLASHES);
} catch (Throwable $e) {
  http_response_code(500);
  echo json_encode(["ok" => false, "error" => "server_error"]);
}
