<?php
// api/ai_intake.php
declare(strict_types=1);

header("Content-Type: application/json; charset=utf-8");
require __DIR__ . "/db.php";

function bad(string $msg, int $code = 400, array $extra = []): void {
  http_response_code($code);
  echo json_encode(array_merge(["ok" => false, "error" => $msg], $extra), JSON_UNESCAPED_SLASHES);
  exit;
}

function readApiKey(): string {
  $path = "/etc/musclemap/xai_api_key";
  $key = @file_get_contents($path);
  if ($key === false) return "";
  $key = trim($key);
  return $key;
}

function jsonTextFromAssistant($content): string {
  // xAI/OpenAI-compatible responses often return a string, but can be an array of parts.
  if (is_string($content)) return $content;
  if (is_array($content)) {
    $out = "";
    foreach ($content as $part) {
      if (is_array($part) && ($part["type"] ?? "") === "text") {
        $out .= (string)($part["text"] ?? "");
      }
    }
    return $out;
  }
  return "";
}

function clamp01(float $x): float {
  if ($x < 0.0) return 0.0;
  if ($x > 1.0) return 1.0;
  return $x;
}

function normalizeId(string $s): string {
  // snake_case, 2..64, starting with letter/number
  $s = strtolower(trim($s));
  $s = preg_replace('/[^a-z0-9_]+/', '_', $s) ?? "";
  $s = preg_replace('/_+/', '_', $s) ?? "";
  $s = trim($s, "_");
  if (strlen($s) < 2) $s = "ex_" . $s;
  if (strlen($s) > 64) $s = substr($s, 0, 64);
  if (!preg_match('/^[a-z0-9_]{2,64}$/', $s)) $s = "ex_" . bin2hex(random_bytes(4));
  return $s;
}

function getAllowedGroupIds(): array {
  // Keep this list ONLY in JS long-term if you want,
  // but server still must defend itself. This is minimal drift-risk:
  // copy/paste ids from muscleMap.js GROUPS.
  return [
    "abs_upper","abs_lower","obliques_external","obliques_internal","core_deep",
    "chest","lats","upper_back","mid_back","lower_back",
    "shoulders","front_delts","side_delts","rear_delts",
    "biceps","triceps","forearms",
    "quads","hamstrings","glutes","calves",
    "upper_traps","posterior_chain",
    "core",
  ];
}

/* =========================
   Input: multipart/form-data
   - image (optional): jpg/png
   - text  (optional)
   Also supports JSON body: { text: "...", image_b64: "data:image/..;base64,..." }
========================= */

$text = "";
$imageDataUrl = null;

$contentType = $_SERVER["CONTENT_TYPE"] ?? "";

if (stripos($contentType, "application/json") !== false) {
  $raw = file_get_contents("php://input");
  $body = json_decode($raw ?: "", true);
  if (!is_array($body)) bad("invalid_json");
  $text = isset($body["text"]) ? trim((string)$body["text"]) : "";
  if (isset($body["image_b64"]) && is_string($body["image_b64"]) && $body["image_b64"] !== "") {
    $imageDataUrl = $body["image_b64"];
  }
} else {
  $text = isset($_POST["text"]) ? trim((string)$_POST["text"]) : "";

  if (isset($_FILES["image"]) && is_array($_FILES["image"]) && ($_FILES["image"]["error"] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_OK) {
    $tmp = (string)$_FILES["image"]["tmp_name"];
    $mime = @mime_content_type($tmp) ?: "";
    if ($mime !== "image/jpeg" && $mime !== "image/png") bad("bad_image_type");
    $bytes = @file_get_contents($tmp);
    if ($bytes === false || $bytes === "") bad("bad_image");
    $b64 = base64_encode($bytes);
    $imageDataUrl = "data:" . $mime . ";base64," . $b64;
  }
}

if ($text === "" && !$imageDataUrl) bad("missing_input");

/* =========================
   Build prompt
========================= */
$allowedIds = getAllowedGroupIds();
$allowedStr = implode(", ", $allowedIds);

$system = <<<SYS
You are MuscleMap's exercise intake assistant.
Return ONLY valid JSON. No markdown. No extra text.

Goal:
Given the user's description and optional image, determine if the exercise already exists in the provided exercise list.
If it exists, return action="exists" with the existing exercise_key.
If it does not, return action="add" with a new exercise_key, a clean human name, and a weights map.

Constraints:
- weights keys MUST be one of the allowed muscle group ids:
  [$allowedStr]
- weights values are floats 0.0 to 1.0 (higher = more targeted).
- include only 1 to 6 muscle groups, keep it realistic.
- If uncertain, choose fewer groups and lower weights.
- exercise_key must be snake_case a-z0-9_ (2..64).
JSON schema (exact keys):
{
  "action": "exists" | "add",
  "exercise_key": "string",
  "name": "string",
  "weights": { "group_id": number, ... },
  "confidence": number
}
SYS;

try {
  // pull current exercises so AI can decide "exists"
  $stmt = $pdo->prepare("
    SELECT exercise_key, name
    FROM exercises
    WHERE user_id = :uid AND is_active = 1
    ORDER BY name ASC
  ");
  $stmt->execute([":uid" => GLOBAL_USER_ID]);

  $exerciseList = [];
  foreach ($stmt->fetchAll() as $r) {
    $exerciseList[] = [
      "id" => (string)$r["exercise_key"],
      "name" => (string)$r["name"],
    ];
  }

  $existingJson = json_encode($exerciseList, JSON_UNESCAPED_SLASHES);

} catch (Throwable $e) {
  bad("db_error", 500);
}

$userText = "User text:\n" . ($text !== "" ? $text : "(none)") . "\n\nExisting exercises (JSON):\n" . $existingJson;

/* =========================
   Call xAI
   - Base: https://api.x.ai
   - Endpoint: /v1/chat/completions
   - Auth: Authorization: Bearer <key>
   - Image input via content parts (image_url) :contentReference[oaicite:1]{index=1}
========================= */

$key = readApiKey();
if ($key === "") bad("missing_api_key", 500);

$messages = [];

$messages[] = [
  "role" => "system",
  "content" => [
    ["type" => "text", "text" => $system]
  ]
];

$userContent = [];
if ($imageDataUrl) {
  $userContent[] = [
    "type" => "image_url",
    "image_url" => [
      "url" => $imageDataUrl,
      "detail" => "high"
    ]
  ];
}
$userContent[] = ["type" => "text", "text" => $userText];

$messages[] = [
  "role" => "user",
  "content" => $userContent
];

$payload = [
  "model" => "grok-4",
  "temperature" => 0.2,
  "messages" => $messages,
];

$ch = curl_init("https://api.x.ai/v1/chat/completions");
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_POST => true,
  CURLOPT_HTTPHEADER => [
    "Authorization: Bearer " . $key,
    "Content-Type: application/json",
  ],
  CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_SLASHES),
  CURLOPT_TIMEOUT => 90,
]);

$rawResp = curl_exec($ch);
$http = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
$err = curl_error($ch);
curl_close($ch);

if ($rawResp === false || $rawResp === "" || $http < 200 || $http >= 300) {
  bad("xai_error", 502, [
    "http" => $http,
    "curl" => $err ?: null,
    "hint" => "Check API key permissions + model access."
  ]);
}

$resp = json_decode($rawResp, true);
if (!is_array($resp)) bad("xai_bad_json", 502);

$content = $resp["choices"][0]["message"]["content"] ?? null;
$textOut = trim(jsonTextFromAssistant($content));
if ($textOut === "") bad("xai_empty", 502);

// Must be pure JSON. Extract if model wrapped it.
$firstBrace = strpos($textOut, "{");
$lastBrace = strrpos($textOut, "}");
if ($firstBrace !== false && $lastBrace !== false && $lastBrace > $firstBrace) {
  $textOut = substr($textOut, $firstBrace, $lastBrace - $firstBrace + 1);
}

$ai = json_decode($textOut, true);
if (!is_array($ai)) bad("ai_not_json", 502, ["raw" => substr($textOut, 0, 400)]);

/* =========================
   Validate + normalize AI output
========================= */
$action = strtolower((string)($ai["action"] ?? ""));
$exercise_key = (string)($ai["exercise_key"] ?? "");
$name = trim((string)($ai["name"] ?? ""));
$weights = $ai["weights"] ?? null;
$confidence = (float)($ai["confidence"] ?? 0);

if ($action !== "add" && $action !== "exists") bad("ai_bad_action", 502);
if ($exercise_key === "") bad("ai_missing_exercise_key", 502);

$exercise_key = normalizeId($exercise_key);
if ($name === "" || mb_strlen($name) > 128) {
  // if exists, name can be empty; but we still prefer it for UI
  if ($action === "add") bad("ai_bad_name", 502);
}

if ($action === "exists") {
  // verify it truly exists in DB (avoid hallucinations)
  $stmt = $pdo->prepare("
    SELECT 1
    FROM exercises
    WHERE user_id = :uid AND exercise_key = :ek AND is_active = 1
    LIMIT 1
  ");
  $stmt->execute([":uid" => GLOBAL_USER_ID, ":ek" => $exercise_key]);
  $ok = (bool)$stmt->fetchColumn();

  if (!$ok) {
    // downgrade: treat as add, but require weights
    $action = "add";
  } else {
    echo json_encode([
      "ok" => true,
      "action" => "exists",
      "id" => $exercise_key,
      "confidence" => $confidence,
    ], JSON_UNESCAPED_SLASHES);
    exit;
  }
}

// action == add requires weights
if (!is_array($weights)) bad("ai_bad_weights", 502);

// enforce allowed group ids
$allowedSet = array_fill_keys($allowedIds, true);
$clean = [];
foreach ($weights as $k => $v) {
  if (!is_string($k)) continue;
  if (!isset($allowedSet[$k])) continue;
  if (!is_numeric($v)) continue;
  $clean[$k] = clamp01((float)$v);
}
if (!$clean) bad("ai_empty_weights_after_filter", 502);

// 1..6 groups max
if (count($clean) > 6) {
  // keep top 6 by weight
  arsort($clean);
  $clean = array_slice($clean, 0, 6, true);
}

$weightsJson = json_encode($clean, JSON_UNESCAPED_SLASHES);

/* =========================
   Upsert into exercises as source='ai'
========================= */
try {
  $stmt = $pdo->prepare("
    INSERT INTO exercises (user_id, exercise_key, name, weights_json, source, is_active)
    VALUES (:uid, :ek, :nm, CAST(:wj AS JSON), 'ai', 1)
    ON DUPLICATE KEY UPDATE
      name = VALUES(name),
      weights_json = VALUES(weights_json),
      source = 'ai',
      is_active = 1,
      updated_at = CURRENT_TIMESTAMP
  ");

  $stmt->execute([
    ":uid" => GLOBAL_USER_ID,
    ":ek"  => $exercise_key,
    ":nm"  => $name === "" ? $exercise_key : $name,
    ":wj"  => $weightsJson,
  ]);

  echo json_encode([
    "ok" => true,
    "action" => "add",
    "id" => $exercise_key,
    "name" => ($name === "" ? $exercise_key : $name),
    "weights" => $clean,
    "confidence" => $confidence,
  ], JSON_UNESCAPED_SLASHES);
} catch (Throwable $e) {
  bad("server_error", 500);
}
