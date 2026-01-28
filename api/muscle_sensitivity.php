<?php
// api/muscle_sensitivity.php
declare(strict_types=1);

require __DIR__ . "/db.php";

// Enforce login
require_user_id();

header("Content-Type: application/json; charset=utf-8");

// Avoid name collision with db.php's json_err()
function mm_ok(array $extra = []): void {
  echo json_encode(["ok" => true] + $extra, JSON_UNESCAPED_SLASHES);
  exit;
}
function mm_fail(string $msg, int $code = 400, array $extra = []): void {
  http_response_code($code);
  echo json_encode(["ok" => false, "error" => $msg] + $extra, JSON_UNESCAPED_SLASHES);
  exit;
}
function mm_read_json(): array {
  $raw = file_get_contents("php://input");
  if ($raw === false) mm_fail("bad_body", 400);
  $raw = trim($raw);
  if ($raw === "") return [];
  $data = json_decode($raw, true);
  if (!is_array($data)) mm_fail("bad_json", 400);
  return $data;
}
function mm_is_finite(float $x): bool {
  return is_finite($x);
}
function mm_clamp(float $x, float $lo, float $hi): float {
  if ($x < $lo) return $lo;
  if ($x > $hi) return $hi;
  return $x;
}
function mm_valid_gid(string $gid): bool {
  // keep it permissive but safe
  // your real allowed set is enforced client-side by selection anyway
  return (bool)preg_match('/^[a-z0-9_]{2,64}$/', $gid);
}

$uid = (int)GLOBAL_USER_ID;
$method = $_SERVER["REQUEST_METHOD"] ?? "GET";

try {
  if ($method === "GET") {
    $stmt = $pdo->prepare("SELECT group_id, sensitivity FROM muscle_sensitivity WHERE user_id = ?");
    $stmt->execute([$uid]);

    $map = [];
    while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
      $gid = (string)($row["group_id"] ?? "");
      $val = (float)($row["sensitivity"] ?? 1.0);
      if ($gid !== "") $map[$gid] = $val;
    }

    mm_ok(["map" => $map]);
  }

  if ($method === "POST") {
    $body = mm_read_json();

    // accept either:
    // 1) { "group_id": "...", "sensitivity": 1.2 }
    // 2) { "map": { "chest": 1.1, "biceps": 0.9 } }
    $items = [];

    if (isset($body["map"]) && is_array($body["map"])) {
      foreach ($body["map"] as $gid => $val) {
        $items[] = [(string)$gid, $val];
      }
    } elseif (isset($body["group_id"])) {
      $items[] = [(string)$body["group_id"], $body["sensitivity"] ?? null];
    } else {
      mm_fail("missing_group_id_or_map", 400);
    }

    $sql = "
      INSERT INTO muscle_sensitivity (user_id, group_id, sensitivity, updated_at)
      VALUES (?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE
        sensitivity = VALUES(sensitivity),
        updated_at = NOW()
    ";
    $stmt = $pdo->prepare($sql);

    $saved = 0;

    foreach ($items as $pair) {
      $gid = trim((string)($pair[0] ?? ""));
      if ($gid === "" || !mm_valid_gid($gid)) continue;

      $rawVal = $pair[1] ?? null;
      if (!is_numeric($rawVal)) continue;

      $v = (float)$rawVal;
      if (!mm_is_finite($v)) continue;

      // clamp to sane range (matches your UI)
      $v = mm_clamp($v, 0.05, 1.5);

      $stmt->execute([$uid, $gid, $v]);
      $saved++;
    }

    mm_ok(["saved" => $saved]);
  }

  mm_fail("method_not_allowed", 405);
} catch (Throwable $e) {
  mm_fail("server_error", 500);
}
