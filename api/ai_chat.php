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
    if ($key === false) return "";
    return trim($key);
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

function clamp01(float $x): float {
    return max(0.0, min(1.0, $x));
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

function exactMatchExercise(array $dbExercises, string $name, array $weights): ?array {
    $nName   = mb_strtolower(trim($name));
    $nWeights = weightsNormalize($weights);

    foreach ($dbExercises as $ex) {
        $dbName = mb_strtolower(trim((string)($ex["name"] ?? "")));
        if ($dbName !== $nName) continue;

        $dbW = weightsNormalize($ex["w"] ?? []);
        if ($dbW === $nWeights) return $ex;
    }
    return null;
}

/* ────────────────────────────────────────────────
   Input handling
───────────────────────────────────────────────── */
$payloadRaw = $_POST["payload"] ?? "";
if (!is_string($payloadRaw) || $payloadRaw === "") bad("missing_payload");

$payload = json_decode($payloadRaw, true);
if (!is_array($payload)) bad("bad_payload_json");

$history = $payload["history"] ?? [];
$text    = trim((string)($payload["text"] ?? ""));

if (!is_array($history)) $history = [];

$hasImage = isset($_FILES["image"]) && is_array($_FILES["image"]) && ($_FILES["image"]["error"] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_OK;

if ($text === "" && !$hasImage) {
    bad("missing_input");
}

$imageDataUrl = null;
if ($hasImage) {
    $tmp = (string)$_FILES["image"]["tmp_name"];
    $mime = @mime_content_type($tmp) ?: "";
    if (!in_array($mime, ["image/jpeg", "image/png"])) bad("bad_image_type");
    $bytes = @file_get_contents($tmp);
    if ($bytes === false || $bytes === "") bad("bad_image");
    $b64 = base64_encode($bytes);
    $imageDataUrl = "data:$mime;base64,$b64";
}

/* ────────────────────────────────────────────────
   Allowed muscle groups (must match GROUPS in JS)
───────────────────────────────────────────────── */
$allowedIds = [
    "abs_upper","abs_lower","obliques_external","obliques_internal","core_deep",
    "chest","lats","upper_back","mid_back","lower_back",
    "shoulders","front_delts","side_delts","rear_delts",
    "biceps","triceps","forearms",
    "quads","hamstrings","glutes","calves",
    "upper_traps","posterior_chain",
    "core",
];

$allowedStr = implode(", ", $allowedIds);
$exJson = json_encode($dbExercises ?? [], JSON_UNESCAPED_SLASHES);

/* ────────────────────────────────────────────────
   System prompt
───────────────────────────────────────────────── */
$system = <<<SYS
You are MuscleMap's chat intake assistant.

Return ONLY valid JSON. No markdown. No extra text. No explanations outside the JSON.

Your job each turn:
- Understand the user's message (and optional image description if provided).
- Decide one of these reply types:
  1) "error"    → you cannot proceed (bad image, nonsense input, etc.)
  2) "question" → ask clarifying question, optionally with 2–5 choices
  3) "exists"   → ONLY if it is EXACTLY the same exercise (same name + same weights)
  4) "propose_add" → propose a new entry / variation

Rules:
- "exists" only on perfect match — if even slightly different → propose_add
- For propose_add: choose 1–6 muscle groups, realistic weights 0.0–1.0
- Allowed muscle group ids ONLY: [$allowedStr]
- exercise_key: snake_case [a-z0-9_]{2,64}, descriptive but short
- confidence: 0.0–1.0 (how sure you are of the proposal)
- Be conservative — if unsure, ask question instead of guessing

JSON schema (exact, no extra fields):
{
  "type": "error" | "question" | "exists" | "propose_add",
  "text": "string (user-facing message)",

  // question only
  "choices": ["string", ...] (optional, 2–5 quick replies),

  // exists only
  "id": "exercise_key",
  "name": "string",

  // propose_add only
  "proposal": {
    "exercise_key": "string",
    "name": "string",
    "weights": { "group_id": number, ... },
    "confidence": number
  }
}

Existing exercises (for reference — do NOT add duplicates):
$exJson
SYS;

/* ────────────────────────────────────────────────
   Build messages for xAI (OpenAI-compatible)
───────────────────────────────────────────────── */
$modelMessages = [
    [
        "role"    => "system",
        "content" => $system
    ]
];

// Replay history (text only — images already processed)
foreach ($history as $m) {
    if (!is_array($m)) continue;
    $role = strtolower((string)($m["role"] ?? ""));
    if (!in_array($role, ["user", "assistant"])) continue;
    $t = trim((string)($m["text"] ?? ""));
    if ($t === "") continue;

    $modelMessages[] = [
        "role"    => $role,
        "content" => $t
    ];
}

// Current turn
$currentContent = [];
if ($imageDataUrl) {
    $currentContent[] = [
        "type"      => "image_url",
        "image_url" => ["url" => $imageDataUrl, "detail" => "high"]
    ];
}
if ($text !== "") {
    $currentContent[] = ["type" => "text", "text" => $text];
} else if ($imageDataUrl) {
    $currentContent[] = ["type" => "text", "text" => "(user uploaded an image only — describe the exercise / pose / muscles you see)"];
}

$modelMessages[] = [
    "role"    => "user",
    "content" => $currentContent
];

/* ────────────────────────────────────────────────
   Call xAI API
───────────────────────────────────────────────── */
$key = readApiKey();
if ($key === "") bad("missing_api_key", 500);

$requestPayload = [
    "model"       => "grok-4-0709",          // ← change to current model: grok-3, grok-3-mini, grok-2-latest, etc.
    "messages"    => $modelMessages,
    "temperature" => 0.2,
    "max_tokens"  => 1200,                 // prevent runaway
];

$ch = curl_init("https://api.x.ai/v1/chat/completions");

curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER    => true,
    CURLOPT_POST              => true,
    CURLOPT_POSTFIELDS        => json_encode($requestPayload),
    CURLOPT_HTTPHEADER        => [
        "Authorization: Bearer $key",
        "Content-Type: application/json",
    ],
    CURLOPT_TIMEOUT           => 60,       // lower if still timing out
    CURLOPT_CONNECTTIMEOUT    => 10,
    CURLOPT_FOLLOWLOCATION    => true,
    CURLOPT_FAILONERROR       => false,    // we'll handle http codes
]);

$rawResponse = curl_exec($ch);
$httpCode    = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlErr     = curl_error($ch);
curl_close($ch);

if ($curlErr !== "") {
    bad("xAI curl error: $curlErr", 502);
}

if ($httpCode !== 200) {
    bad("xAI HTTP $httpCode", 502, ["raw" => substr($rawResponse, 0, 800)]);
}

$aiJson = json_decode($rawResponse, true);
if (!is_array($aiJson) || !isset($aiJson["choices"][0]["message"]["content"])) {
    bad("Invalid xAI response format", 502, ["raw" => substr($rawResponse, 0, 800)]);
}

$assistantContent = $aiJson["choices"][0]["message"]["content"];
$assistantJson    = json_decode($assistantContent, true);

if (!is_array($assistantJson) || !isset($assistantJson["type"])) {
    bad("AI did not return valid structured JSON", 500, ["content" => substr($assistantContent, 0, 600)]);
}

// ────────────────────────────────────────────────
// Normalize & validate reply a bit
$reply = $assistantJson;

// Optional: extra server-side validation / cleanup
if ($reply["type"] === "propose_add" && isset($reply["proposal"])) {
    $p = &$reply["proposal"];
    $p["exercise_key"] = normalizeId($p["exercise_key"] ?? "");
    $p["weights"]      = weightsNormalize($p["weights"] ?? []);
    $p["confidence"]   = clamp01((float)($p["confidence"] ?? 0.5));
}

// Prepare response for client
$result = [
    "ok"       => true,
    "assistant" => [
        "role"     => "assistant",
        "text"     => $reply["text"] ?? "(no message)",
        "reply"    => $reply,
        "raw_json" => $assistantJson,           // for debug panel
    ],
    "history"  => array_merge($history, [
        ["role" => "user", "text" => $text],
        ["role" => "assistant", "text" => $reply["text"] ?? ""]
    ]),
];

if ($imageDataUrl) {
    // So client can show the uploaded image in history
    $result["history"][count($result["history"]) - 2]["image_b64"] = $imageDataUrl;
}

echo json_encode($result, JSON_UNESCAPED_SLASHES);