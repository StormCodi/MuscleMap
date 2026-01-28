<?php
// api/muscle_sensitivity.php
declare(strict_types=1);

header("Content-Type: application/json; charset=utf-8");

function json_ok(array $extra = []): void {
  echo json_encode(["ok" => true] + $extra, JSON_UNESCAPED_SLASHES);
  exit;
}
function json_err(string $msg, int $code = 400): void {
  http_response_code($code);
  echo json_encode(["ok" => false, "error" => $msg], JSON_UNESCAPED_SLASHES);
  exit;
}
function read_json_body(): array {
  $raw = file_get_contents("php://input");
  if ($raw === false || trim($raw) === "") return [];
  $data = json_decode($raw, true);
  if (!is_array($data)) json_err("bad_json", 400);
  return $data;
}

require_once __DIR__ . "/db.php";

/**
 * Be defensive: your db.php might expose PDO differently.
 */
function resolve_pdo(): PDO {
  // common patterns
  if (function_exists("db")) {
    $pdo = db();
    if ($pdo instanceof PDO) return $pdo;
  }
  if (function_exists("get_pdo")) {
    $pdo = get_pdo();
    if ($pdo instanceof PDO) return $pdo;
  }
  // $pdo in global scope
  if (isset($GLOBALS["pdo"]) && $GLOBALS["pdo"] instanceof PDO) return $GLOBALS["pdo"];

  json_err("db_unavailable", 500);
}

$USER_ID = defined("GLOBAL_USER_ID") ? (int)GLOBAL_USER_ID : 0;

$pdo = resolve_pdo();
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

// create table if missing? (NO) -> keep explicit migration
// main operations:

$method = $_SERVER["REQUEST_METHOD"] ?? "GET";

try {
  if ($method === "GET") {
    $stmt = $pdo->prepare("SELECT group_id, sensitivity FROM muscle_sensitivity WHERE user_id = ?"); 
    $stmt->execute([$USER_ID]);
    $map = [];
    while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
      $gid = (string)($row["group_id"] ?? "");
      $val = (float)($row["sensitivity"] ?? 1.0);
      if ($gid !== "") $map[$gid] = $val;
    }
    json_ok(["map" => $map]);
  }

  if ($method === "POST") {
    $body = read_json_body();

    // accept either:
    // 1) { "group_id": "...", "sensitivity": 1.2 }
    // 2) { "map": { "chest": 1.1, "biceps": 0.9 } }
    $items = [];

    if (isset($body["map"]) && is_array($body["map"])) {
      foreach ($body["map"] as $gid => $val) {
        $items[] = [ (string)$gid, $val ];
      }
    } elseif (isset($body["group_id"])) {
      $items[] = [ (string)$body["group_id"], $body["sensitivity"] ?? null ];
    } else {
      json_err("missing_group_id_or_map", 400);
    }

    // upsert each row
    $sql = "
      INSERT INTO muscle_sensitivity (user_id, group_id, sensitivity, updated_at)
      VALUES (?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE
        sensitivity = VALUES(sensitivity),
        updated_at = NOW()
    ";
    $stmt = $pdo->prepare($sql);

    $saved = 0;
    foreach ($items as [$gidRaw, $valRaw]) {
      $gid = trim((string)$gidRaw);
      if ($gid === "") continue;

      $v = (float)$valRaw;
      if (!is_finite($v)) continue;

      // clamp to sane range
      if ($v < 0.05) $v = 0.05;
      if ($v > 1.5) $v = 1.5;

      $stmt->execute([$USER_ID, $gid, $v]);
      $saved++;
    }

    json_ok(["saved" => $saved]);
  }

  json_err("method_not_allowed", 405);
} catch (Throwable $e) {
  json_err("server_error", 500);
}
