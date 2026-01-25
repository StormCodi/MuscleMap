<?php
// api/ai_chat.php
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
  return $key === false ? "" : trim($key);
}

function clamp01(float $x): float {
  return max(0.0, min(1.0, $x));
}

function normalizeId(string $s): string {
  $s = strtolower(trim($s));
  $s = preg_replace('/[^a-z0-9_]+/', '_', $s) ?? "";
  $s = preg_replace('/_+/', '_', $s) ?? "";
  $s = trim($s, "_");
  if (strlen($s) < 2) $s = "ex_" . $s;
  if (strlen($s) > 64) $s = substr($s, 0, 64);
  if (!preg_match('/^[a-z0-9_]{2,64}$/', $s)) $s = "ex_" . bin2hex(random_bytes(4));
  return $s;
}

function weightsNormalize($w): array {
  if (!is_array($w)) return [];
  $out = [];
  foreach ($w as $k => $v) {
    if (!is_string($k)) continue;
    if (!is_numeric($v)) continue;
    $fv = round(clamp01((float)$v), 2);
    if ($fv <= 0) continue;
    $out[$k] = $fv;
  }
  ksort($out);
  return $out;
}

function normalizeName(string $s): string {
  $s = mb_strtolower(trim($s));
  $s = preg_replace('/\s+/', ' ', $s) ?? $s;
  return $s;
}

function exactMatchExercise(array $dbExercises, string $name, array $weights): ?array {
  $nName = normalizeName($name);
  $nW = weightsNormalize($weights);
  foreach ($dbExercises as $ex) {
    if (normalizeName((string)$ex["name"]) !== $nName) continue;
    $dbW = weightsNormalize($ex["w"] ?? []);
    if ($dbW === $nW) return $ex;
  }
  return null;
}

function assistantTextFromContent($content): string {
  // xAI may return string or array parts
  if (is_string($content)) return $content;
  if (is_array($content)) {
    $out = "";
    foreach ($content as $p) {
      if (is_array($p) && ($p["type"] ?? "") === "text") {
        $out .= (string)($p["text"] ?? "");
      }
    }
    return $out;
  }
  return "";
}

/* ─────────────────────────────
   Input
───────────────────────────── */
$payloadRaw = $_POST["payload"] ?? "";
if (!is_string($payloadRaw) || $payloadRaw === "") bad("missing_payload");

$payload = json_decode($payloadRaw, true);
if (!is_array($payload)) bad("bad_payload_json");

$history = $payload["history"] ?? [];
$text = trim((string)($payload["text"] ?? ""));

if (!is_array($history)) $history = [];

$hasImage = isset($_FILES["image"]) && is_array($_FILES["image"]) && (($_FILES["image"]["error"] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_OK);

if ($text === "" && !$hasImage) bad("missing_input");

$imageDataUrl = null;
if ($hasImage) {
  $tmp = (string)$_FILES["image"]["tmp_name"];
  $mime = @mime_content_type($tmp) ?: "";
  if (!in_array($mime, ["image/jpeg", "image/png"], true)) bad("bad_image_type");
  $bytes = @file_get_contents($tmp);
  if ($bytes === false || $bytes === "") bad("bad_image");
  $b64 = base64_encode($bytes);
  $imageDataUrl = "data:$mime;base64,$b64";
}

/* ─────────────────────────────
   Load ALL exercises (name + weights)
───────────────────────────── */
try {
  $stmt = $pdo->prepare("
    SELECT exercise_key, name, weights_json
    FROM exercises
    WHERE user_id = :uid AND is_active = 1
    ORDER BY name ASC
  ");
  $stmt->execute([":uid" => GLOBAL_USER_ID]);

  $dbExercises = [];
  foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
    $w = json_decode((string)$r["weights_json"], true);
    if (!is_array($w)) $w = [];
    $dbExercises[] = [
      "id" => (string)$r["exercise_key"],
      "name" => (string)$r["name"],
      "w" => weightsNormalize($w),
    ];
  }

  // Give the model the full list (names + weights), so it stops hallucinating duplicates
  $exJson = json_encode($dbExercises, JSON_UNESCAPED_SLASHES);
} catch (Throwable $e) {
  bad("db_error", 500);
}

/* ─────────────────────────────
   Allowed muscle groups
───────────────────────────── */
$allowedIds = [
  "abs_upper","abs_lower","obliques_external","obliques_internal","core_deep",
  "chest","lats","upper_back","mid_back","lower_back",
  "shoulders","front_delts","side_delts","rear_delts",
  "biceps","triceps","forearms",
  "quads","hamstrings","glutes","calves",
  "upper_traps","posterior_chain",
  "core",
];
$allowedSet = array_fill_keys($allowedIds, true);
$allowedStr = implode(", ", $allowedIds);

/* ─────────────────────────────
   System prompt (strict JSON)
───────────────────────────── */
$system = <<<SYS
You are MuscleMap's chat intake assistant.

Return ONLY valid JSON. No markdown. No extra text.

Your job each turn:
- Understand the user's message (and optional image).
- Reply with one type:
  "error" | "question" | "exists" | "propose_add"

Rules:
- "exists" ONLY if it is EXACTLY the same as a DB entry (same name + same weights).
- If it's a variation, use "propose_add".
- For propose_add: 1–6 groups, weights 0.0–1.0 realistic.
- Allowed muscle group ids ONLY: [$allowedStr]
- exercise_key: snake_case [a-z0-9_]{2,64}
- confidence: 0.0–1.0
- If unsure, ask a question.

JSON schema (exact keys):
{
  "type": "error" | "question" | "exists" | "propose_add",
  "text": "string",
  "choices": ["string", ...],
  "id": "exercise_key",
  "name": "string",
  "proposal": {
    "exercise_key": "string",
    "name": "string",
    "weights": { "group_id": number, ... },
    "confidence": number
  }
}

Existing exercises (id, name, weights) JSON:
$exJson
SYS;

/* ─────────────────────────────
   Build model messages (include history)
───────────────────────────── */
$modelMessages = [
  ["role" => "system", "content" => $system],
];

// history: keep it sane server-side too
$history = array_slice($history, -40);

foreach ($history as $m) {
  if (!is_array($m)) continue;
  $role = strtolower((string)($m["role"] ?? ""));
  if (!in_array($role, ["user","assistant"], true)) continue;
  $t = trim((string)($m["text"] ?? ""));
  if ($t === "") continue;
  $modelMessages[] = ["role" => $role, "content" => $t];
}

$currentContent = [];
if ($imageDataUrl) {
  $currentContent[] = [
    "type" => "image_url",
    "image_url" => ["url" => $imageDataUrl, "detail" => "high"]
  ];
}
$currentContent[] = ["type" => "text", "text" => ($text !== "" ? $text : "(image only — describe the exercise)")];

$modelMessages[] = ["role" => "user", "content" => $currentContent];

/* ─────────────────────────────
   Call xAI
───────────────────────────── */
$key = readApiKey();
if ($key === "") bad("missing_api_key", 500);

$requestPayload = [
  "model" => "grok-4-0709",
  "messages" => $modelMessages,
  "temperature" => 0.2,
  "max_tokens" => 1200,
];

$ch = curl_init("https://api.x.ai/v1/chat/completions");
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_POST => true,
  CURLOPT_POSTFIELDS => json_encode($requestPayload, JSON_UNESCAPED_SLASHES),
  CURLOPT_HTTPHEADER => [
    "Authorization: Bearer $key",
    "Content-Type: application/json",
  ],
  CURLOPT_TIMEOUT => 60,
  CURLOPT_CONNECTTIMEOUT => 10,
  CURLOPT_FOLLOWLOCATION => true,
  CURLOPT_FAILONERROR => false,
]);

$rawResponse = curl_exec($ch);
$httpCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlErr = curl_error($ch);
curl_close($ch);

if ($curlErr !== "") bad("xai_curl_error", 502, ["detail" => $curlErr]);
if ($httpCode !== 200) bad("xai_http_error", 502, ["http" => $httpCode, "raw" => substr((string)$rawResponse, 0, 800)]);

$aiJson = json_decode((string)$rawResponse, true);
if (!is_array($aiJson)) bad("xai_bad_json", 502);

$content = $aiJson["choices"][0]["message"]["content"] ?? null;
$textOut = trim(assistantTextFromContent($content));
if ($textOut === "") bad("xai_empty", 502);

// strip junk around JSON if model misbehaves
$fb = strpos($textOut, "{");
$lb = strrpos($textOut, "}");
if ($fb !== false && $lb !== false && $lb > $fb) {
  $textOut = substr($textOut, $fb, $lb - $fb + 1);
}

$assistantJson = json_decode($textOut, true);
if (!is_array($assistantJson) || !isset($assistantJson["type"])) {
  bad("ai_not_structured_json", 502, ["content" => substr($textOut, 0, 700)]);
}

/* ─────────────────────────────
   Server-side enforcement:
   - validate propose_add weights
   - force exists only on exact match
───────────────────────────── */
$reply = $assistantJson;
$type = (string)($reply["type"] ?? "error");

if ($type === "exists") {
  $rid = (string)($reply["id"] ?? "");
  $rname = (string)($reply["name"] ?? "");
  // exists requires exact match by name+weights — we require weights too, so downgrade if missing
  // If model didn’t include weights, we can’t verify exactness -> question
  $reply = [
    "type" => "question",
    "text" => "I need one detail to confirm exact match: what muscles should this hit (main ones)?",
    "choices" => ["Triceps", "Biceps", "Chest", "Back", "Legs", "Core"],
  ];
}

if ($type === "propose_add" && isset($reply["proposal"]) && is_array($reply["proposal"])) {
  $p = $reply["proposal"];
  $pKey = normalizeId((string)($p["exercise_key"] ?? ""));
  $pName = trim((string)($p["name"] ?? ""));
  $pConf = clamp01((float)($p["confidence"] ?? 0.5));
  $pWraw = $p["weights"] ?? null;

  $cleanW = [];
  if (is_array($pWraw)) {
    foreach ($pWraw as $k => $v) {
      if (!is_string($k)) continue;
      if (!isset($allowedSet[$k])) continue;
      if (!is_numeric($v)) continue;
      $fv = round(clamp01((float)$v), 2);
      if ($fv <= 0) continue;
      $cleanW[$k] = $fv;
    }
  }
  arsort($cleanW);
  $cleanW = array_slice($cleanW, 0, 6, true);
  ksort($cleanW);

  if ($pName === "" || !$cleanW) {
    $reply = [
      "type" => "question",
      "text" => "I’m not confident enough yet. What’s the exact exercise name and the main muscle it targets?",
      "choices" => ["Triceps", "Biceps", "Chest", "Back", "Legs", "Core"],
    ];
  } else {
    // exact-match check across ALL exercises
    $match = exactMatchExercise($dbExercises, $pName, $cleanW);
    if ($match) {
      $reply = [
        "type" => "exists",
        "text" => "Exact match already exists in the database.",
        "id" => (string)$match["id"],
        "name" => (string)$match["name"],
      ];
    } else {
      $reply["proposal"] = [
        "exercise_key" => $pKey,
        "name" => $pName,
        "weights" => $cleanW,
        "confidence" => $pConf,
      ];
    }
  }
}

/* ─────────────────────────────
   Return updated history (text only; no huge base64 stored)
───────────────────────────── */
$nextHistory = $history;
$nextHistory[] = ["role" => "user", "text" => $text !== "" ? $text : "(image)"];
$nextHistory[] = ["role" => "assistant", "text" => (string)($reply["text"] ?? "")];

echo json_encode([
  "ok" => true,
  "assistant" => [
    "role" => "assistant",
    "text" => (string)($reply["text"] ?? "(no message)"),
    "reply" => $reply,
    "raw_json" => $assistantJson, // debug
  ],
  "history" => $nextHistory,
], JSON_UNESCAPED_SLASHES);
