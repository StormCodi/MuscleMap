<?php
declare(strict_types=1);
header("Content-Type: application/json; charset=utf-8");

require __DIR__ . "/db.php";

function bad(string $msg, int $code = 400): void {
  http_response_code($code);
  echo json_encode(["ok" => false, "error" => $msg], JSON_UNESCAPED_SLASHES);
  exit;
}

$raw = file_get_contents("php://input");
$body = json_decode($raw ?: "", true);
if (!is_array($body)) bad("invalid_json");

$id   = isset($body["id"]) ? (string)$body["id"] : "";
$name = isset($body["name"]) ? trim((string)$body["name"]) : "";
$w    = $body["w"] ?? null;

if ($id === "" || !preg_match('/^[a-z0-9_]{2,64}$/', $id)) bad("bad_id");
if ($name === "" || mb_strlen($name) > 128) bad("bad_name");
if (!is_array($w)) bad("bad_weights");

// validate weights: keys snake_case, values 0..1
$clean = [];
foreach ($w as $k => $v) {
  if (!is_string($k) || !preg_match('/^[a-z0-9_]{2,64}$/', $k)) continue;
  if (!is_numeric($v)) continue;
  $fv = (float)$v;
  if ($fv < 0.0) $fv = 0.0;
  if ($fv > 1.0) $fv = 1.0;
  $clean[$k] = $fv;
}
if (!$clean) bad("empty_weights");

$weightsJson = json_encode($clean, JSON_UNESCAPED_SLASHES);

try {
  // upsert by (user_id, exercise_key)
  $stmt = $pdo->prepare("
    INSERT INTO exercises_custom (user_id, exercise_key, name, weights_json)
    VALUES (:uid, :ek, :nm, CAST(:wj AS JSON))
    ON DUPLICATE KEY UPDATE
      name = VALUES(name),
      weights_json = VALUES(weights_json),
      updated_at = CURRENT_TIMESTAMP
  ");

  $stmt->execute([
    ":uid" => GLOBAL_USER_ID,
    ":ek"  => $id,
    ":nm"  => $name,
    ":wj"  => $weightsJson,
  ]);

  echo json_encode(["ok" => true], JSON_UNESCAPED_SLASHES);
} catch (Throwable $e) {
  http_response_code(500);
  echo json_encode(["ok" => false, "error" => "server_error"]);
}

