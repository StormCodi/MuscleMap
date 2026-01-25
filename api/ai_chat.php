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

function clamp01(float $x): float { return max(0.0, min(1.0, $x)); }

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

function normalizeName(string $s): string {
  $s = mb_strtolower(trim($s));
  $s = preg_replace('/\s+/', ' ', $s) ?? $s;
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
   Input: JSON body (preferred) OR fallback form payload
   Your frontend sends JSON: { history, text, image_tokens }
   NOTE: images are NOT required.
───────────────────────────── */
$rawBody = file_get_contents("php://input");
$payload = null;

if (is_string($rawBody) && trim($rawBody) !== "") {
  $payload = json_decode($rawBody, true);
  if (!is_array($payload)) bad("bad_json");
} else {
  // fallback (older)
  $payloadRaw = $_POST["payload"] ?? "";
  if (!is_string($payloadRaw) || $payloadRaw === "") bad("missing_payload");
  $payload = json_decode($payloadRaw, true);
  if (!is_array($payload)) bad("bad_payload_json");
}

$history = $payload["history"] ?? [];
$text = trim((string)($payload["text"] ?? ""));
$imageTokens = $payload["image_tokens"] ?? [];

if (!is_array($history)) $history = [];
if (!is_array($imageTokens)) $imageTokens = [];

if ($text === "" && count($imageTokens) === 0) bad("missing_input");

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
   Resolve uploaded image tokens -> data URLs
   Expects files stored by ai_upload.php in /uploads/ai_tmp/{token}.{ext}
   Accepts jpg/png/webp.
───────────────────────────── */
$baseDir = realpath(__DIR__ . "/.."); // /var/www/html/musclemap
if ($baseDir === false) bad("base_dir_fail", 500);

$imgDir = $baseDir . "/uploads/ai_tmp";
$imageDataUrls = [];

$imageTokens = array_values(array_filter($imageTokens, fn($t) => is_string($t) && preg_match('/^[a-f0-9]{32}$/', $t)));
if (count($imageTokens) > 6) $imageTokens = array_slice($imageTokens, 0, 6);

$exts = ["jpg","jpeg","png","webp"];
$mimeMap = ["jpg"=>"image/jpeg","jpeg"=>"image/jpeg","png"=>"image/png","webp"=>"image/webp"];

foreach ($imageTokens as $tok) {
  $path = null;
  $extFound = null;
  foreach ($exts as $ext) {
    $p = $imgDir . "/" . $tok . "." . $ext;
    if (is_file($p)) { $path = $p; $extFound = $ext; break; }
  }
  if ($path === null) continue; // token missing -> ignore (don’t hard fail)

  $bytes = @file_get_contents($path);
  if ($bytes === false || $bytes === "") continue;

  $mime = $mimeMap[$extFound] ?? (@mime_content_type($path) ?: "");
  if ($mime === "" || !in_array($mime, ["image/jpeg","image/png","image/webp"], true)) continue;

  $b64 = base64_encode($bytes);
  $imageDataUrls[] = "data:$mime;base64,$b64";
}

/* ─────────────────────────────
   System prompt (supports multiple proposals)
───────────────────────────── */
$system = <<<SYS
You are MuscleMap's chat intake assistant.

Return ONLY valid JSON. No markdown. No extra text.

Reply types:
- "error"
- "question"
- "exists"
- "propose_add"
- "propose_add_many"  (multiple independent proposals)

Rules:
- "exists" ONLY if it is EXACTLY the same as a DB entry (same name + same weights).
- For proposals: 1–6 muscle groups, weights 0.0–1.0 realistic.
- Allowed muscle group ids ONLY: [$allowedStr]
- exercise_key: snake_case [a-z0-9_]{2,64}
- confidence: 0.0–1.0
- If unsure, ask a question.

JSON schema (exact keys, no extras):
{
  "type": "error" | "question" | "exists" | "propose_add" | "propose_add_many",
  "text": "string",

  "choices": ["string", ...],  // optional, only for question

  "id": "exercise_key",        // only for exists
  "name": "string",            // only for exists

  "proposal": {                // only for propose_add
    "exercise_key": "string",
    "name": "string",
    "weights": { "group_id": number, ... },
    "confidence": number
  },

  "proposals": [               // only for propose_add_many
    {
      "exercise_key": "string",
      "name": "string",
      "weights": { "group_id": number, ... },
      "confidence": number
    }
  ]
}

Existing exercises (id, name, weights) JSON:
$exJson
SYS;

/* ─────────────────────────────
   Build messages (include history)
───────────────────────────── */
$modelMessages = [
  ["role" => "system", "content" => $system],
];

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
foreach ($imageDataUrls as $u) {
  $currentContent[] = [
    "type" => "image_url",
    "image_url" => ["url" => $u, "detail" => "high"]
  ];
}
$currentContent[] = ["type" => "text", "text" => ($text !== "" ? $text : "(images only — describe what exercise(s) these show)")];

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
  "max_tokens" => 1400,
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
   Normalize + server-side enforcement
───────────────────────────── */
$reply = $assistantJson;
$type = (string)($reply["type"] ?? "error");

// helper: normalize a proposal and validate weights+allowed groups
$normProposal = function($p) use ($allowedSet, $dbExercises) {
  if (!is_array($p)) return null;

  $key = normalizeId((string)($p["exercise_key"] ?? ""));
  $name = trim((string)($p["name"] ?? ""));
  $conf = clamp01((float)($p["confidence"] ?? 0.5));

  $wraw = $p["weights"] ?? null;
  $cleanW = [];
  if (is_array($wraw)) {
    foreach ($wraw as $k => $v) {
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

  if ($name === "" || !$cleanW) return null;

  // exact match check
  $match = exactMatchExercise($dbExercises, $name, $cleanW);
  if ($match) {
    return [
      "__kind" => "exists",
      "id" => (string)$match["id"],
      "name" => (string)$match["name"],
    ];
  }

  return [
    "__kind" => "proposal",
    "exercise_key" => $key,
    "name" => $name,
    "weights" => $cleanW,
    "confidence" => $conf,
  ];
};

if ($type === "propose_add") {
  $p = $normProposal($reply["proposal"] ?? null);
  if ($p === null) {
    $reply = [
      "type" => "question",
      "text" => "I’m not confident yet. What’s the exact exercise name and the main muscle it targets?",
      "choices" => ["Triceps", "Biceps", "Chest", "Back", "Legs", "Core"],
    ];
  } else if (($p["__kind"] ?? "") === "exists") {
    $reply = [
      "type" => "exists",
      "text" => "Exact match already exists in the database.",
      "id" => $p["id"],
      "name" => $p["name"],
    ];
  } else {
    unset($p["__kind"]);
    $reply["proposal"] = $p;
  }
} elseif ($type === "propose_add_many") {
  $arr = $reply["proposals"] ?? null;
  if (!is_array($arr) || !$arr) {
    $reply = [
      "type" => "question",
      "text" => "I can propose multiple exercises, but I need a clearer description. What are the exercise names?",
    ];
  } else {
    $outProposals = [];
    $foundExists = [];
    foreach (array_slice($arr, 0, 6) as $p0) {
      $p = $normProposal($p0);
      if ($p === null) continue;
      if (($p["__kind"] ?? "") === "exists") $foundExists[] = $p;
      else { unset($p["__kind"]); $outProposals[] = $p; }
    }

    if ($foundExists && !$outProposals) {
      $e = $foundExists[0];
      $reply = [
        "type" => "exists",
        "text" => "Exact match already exists in the database.",
        "id" => $e["id"],
        "name" => $e["name"],
      ];
    } elseif (!$outProposals) {
      $reply = [
        "type" => "question",
        "text" => "I couldn’t form valid proposals. Tell me each exercise name and what muscles it hits.",
      ];
    } else {
      $reply["proposals"] = $outProposals;
    }
  }
} elseif (!in_array($type, ["error","question","exists"], true)) {
  $reply = [
    "type" => "error",
    "text" => "Unknown reply type from model.",
  ];
}

/* ─────────────────────────────
   Return updated history (text-only)
───────────────────────────── */
$nextHistory = $history;
$nextHistory[] = ["role" => "user", "text" => ($text !== "" ? $text : "(images)")];
$nextHistory[] = ["role" => "assistant", "text" => (string)($reply["text"] ?? "")];

echo json_encode([
  "ok" => true,
  "assistant" => [
    "role" => "assistant",
    "text" => (string)($reply["text"] ?? "(no message)"),
    "reply" => $reply,
    "raw_json" => $assistantJson,
  ],
  "history" => $nextHistory,
], JSON_UNESCAPED_SLASHES);
