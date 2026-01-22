<?php
// api/ai_intake_step.php
declare(strict_types=1);

require __DIR__ . "/db.php";
header("Content-Type: application/json; charset=utf-8");

/* =========================
   Config / Helpers
========================= */

function jsonFail(int $code, string $err, array $extra = []): void {
  http_response_code($code);
  $out = ["ok" => false, "error" => $err];
  if (!empty($extra)) $out["extra"] = $extra;
  echo json_encode($out, JSON_UNESCAPED_SLASHES);
  exit;
}

function readSecretFile(string $path): ?string {
  if (!is_readable($path)) return null;
  $s = @file_get_contents($path);
  if ($s === false) return null;
  $s = trim($s);
  return $s !== "" ? $s : null;
}

function stripJsonFences(string $s): string {
  $t = trim($s);
  $t = preg_replace('/^\s*```json\s*/i', '', $t);
  $t = preg_replace('/^\s*```\s*/', '', $t);
  $t = preg_replace('/\s*```\s*$/', '', $t);
  return trim($t);
}

function normName(string $s): string {
  $s = mb_strtolower(trim($s));
  $s = preg_replace('/[^a-z0-9\s]+/u', ' ', $s);
  $s = preg_replace('/\s+/', ' ', $s);
  return trim($s);
}

function nameSimilarity(string $a, string $b): float {
  $a = normName($a);
  $b = normName($b);
  if ($a === "" || $b === "") return 0.0;
  if ($a === $b) return 1.0;

  $la = strlen($a);
  $lb = strlen($b);
  $max = max($la, $lb);
  if ($max === 0) return 0.0;

  $dist = levenshtein($a, $b);
  $sim = 1.0 - ($dist / $max);
  return max(0.0, min(1.0, $sim));
}

function slugSnake(string $s): string {
  $s = mb_strtolower(trim($s));
  $s = preg_replace('/[^a-z0-9]+/u', '_', $s);
  $s = preg_replace('/_+/', '_', $s);
  $s = trim($s, '_');
  return $s !== "" ? $s : "exercise";
}

/* =========================
   Muscle options (inform + clean server-side)
========================= */

$MUSCLE_GROUPS = [
  "abs_upper","abs_lower","obliques_external","obliques_internal","core_deep",
  "chest","lats","upper_back","mid_back","lower_back",
  "shoulders","front_delts","side_delts","rear_delts",
  "biceps","triceps","forearms",
  "quads","hamstrings","glutes","calves",
  "upper_traps","posterior_chain","core",
];

/* =========================
   xAI config
========================= */

$AI_DEBUG  = (getenv("AI_DEBUG") === "1");

// default: do NOT store images in MySQL (but still send to xAI)
$STORE_IMAGES = (getenv("AI_STORE_IMAGES") === "1");

// Prefer env, fallback to /etc/musclemap/xai_api_key
$XAI_KEY = getenv("XAI_API_KEY");
$XAI_KEY = is_string($XAI_KEY) ? trim($XAI_KEY) : "";
if ($XAI_KEY === "") $XAI_KEY = readSecretFile("/etc/musclemap/xai_api_key") ?? "";
if ($XAI_KEY === "") jsonFail(500, "missing_XAI_API_KEY");

// model default (use one you confirmed works)
$XAI_MODEL = getenv("XAI_MODEL");
$XAI_MODEL = is_string($XAI_MODEL) && trim($XAI_MODEL) !== "" ? trim($XAI_MODEL) : "grok-4-0709";

// hard timeouts
$XAI_CONNECT_TIMEOUT = (int)(getenv("XAI_CONNECT_TIMEOUT") ?: 10);
$XAI_TIMEOUT         = (int)(getenv("XAI_TIMEOUT") ?: 30);

/* =========================
   Input
========================= */

$rawBody = file_get_contents("php://input");
$body = json_decode($rawBody ?: "", true);
if (!is_array($body)) $body = [];

$sessionId    = (int)($body["session_id"] ?? 0);
$text         = trim((string)($body["text"] ?? ""));
$imageDataUrl = (string)($body["image_data_url"] ?? ""); // data:image/*;base64,...

if ($sessionId <= 0) jsonFail(400, "bad_session_id");
if ($text === "" && $imageDataUrl === "") jsonFail(400, "no_input");

/* =========================
   Verify session
========================= */

$stmt = $pdo->prepare("SELECT id, status FROM ai_intake_sessions WHERE id=? AND user_id=?");
$stmt->execute([$sessionId, GLOBAL_USER_ID]);
$sess = $stmt->fetch();
if (!$sess) jsonFail(404, "session_not_found");
if (($sess["status"] ?? "") !== "open") jsonFail(400, "session_not_open");

/* =========================
   Decode image (optional)
   - Always validate size/type
   - Store blob ONLY if AI_STORE_IMAGES=1
========================= */

$imageMime = null;
$imageBlob = null;

if ($imageDataUrl !== "") {
  if (!preg_match('#^data:(image/[a-zA-Z0-9.+-]+);base64,(.+)$#', $imageDataUrl, $m)) {
    jsonFail(400, "bad_image_data_url");
  }
  $imageMime = $m[1];

  $bin = base64_decode($m[2], true);
  if ($bin === false) jsonFail(400, "bad_image_base64");

  // 3MB cap (your existing rule)
  if (strlen($bin) > 3_000_000) jsonFail(400, "image_too_large");

  if ($STORE_IMAGES) $imageBlob = $bin; // else keep null (don’t save)
}

/* =========================
   Save user message
========================= */

$stmt = $pdo->prepare("
  INSERT INTO ai_intake_messages (session_id, role, text, image_mime, image_data)
  VALUES (?, 'user', ?, ?, ?)
");
$stmt->bindValue(1, $sessionId, PDO::PARAM_INT);
$stmt->bindValue(2, $text !== "" ? $text : null, $text !== "" ? PDO::PARAM_STR : PDO::PARAM_NULL);
$stmt->bindValue(3, $imageMime, $imageMime ? PDO::PARAM_STR : PDO::PARAM_NULL);
$stmt->bindValue(4, $imageBlob, $imageBlob ? PDO::PARAM_LOB : PDO::PARAM_NULL);
$stmt->execute();

/* =========================
   Load existing exercises list (id + name)
========================= */

$stmt = $pdo->prepare("
  SELECT exercise_key AS id, name
  FROM exercises
  WHERE user_id=? AND is_active=1
  ORDER BY name ASC
");
$stmt->execute([GLOBAL_USER_ID]);
$existing = $stmt->fetchAll();
if (!is_array($existing)) $existing = [];
$existingJson = json_encode($existing, JSON_UNESCAPED_SLASHES);

/* =========================
   Structured Output Schema (xAI-compatible)
   NOTE: do NOT use allOf/if/then (xAI doesn’t support allOf).
   We validate action-dependent requirements ourselves below.
========================= */

$mmjSchema = [
  "type" => "object",
  "additionalProperties" => false,
  "properties" => [
    "mmj" => ["type" => "string", "enum" => ["1"]],
    "action" => ["type" => "string", "enum" => ["PROPOSE_NEW","MATCH_EXISTING","QUESTION","ERROR"]],
    "message" => ["type" => "string"],

    "proposal" => [
      "type" => "object",
      "additionalProperties" => false,
      "properties" => [
        "exercise_key" => ["type" => "string"],
        "name" => ["type" => "string"],
        "weights" => [
          "type" => "object",
          // keys are dynamic; values must be numbers
          "additionalProperties" => ["type" => "number"]
        ],
        "source" => ["type" => "string", "enum" => ["image","text","mixed"]],
        "confidence" => ["type" => "number"]
      ],
      "required" => ["exercise_key","name","weights","source","confidence"]
    ],

    "match" => [
      "type" => "object",
      "additionalProperties" => false,
      "properties" => [
        "existing_id" => ["type" => "string"],
        "existing_name" => ["type" => "string"],
        "confidence" => ["type" => "number"],
        "reason" => ["type" => "string"]
      ],
      "required" => ["existing_id","existing_name","confidence","reason"]
    ],

    "question" => [
      "type" => "object",
      "additionalProperties" => false,
      "properties" => [
        "id" => ["type" => "string"],
        "text" => ["type" => "string"],
        "type" => ["type" => "string", "enum" => ["text","select"]],
        "choices" => ["type" => "array", "items" => ["type" => "string"]]
      ],
      "required" => ["id","text","type"]
    ],
  ],
  "required" => ["mmj","action","message"],
];

$responseFormat = [
  "type" => "json_schema",
  "json_schema" => [
    "name" => "mmj_intake",
    "strict" => true,
    "schema" => $mmjSchema,
  ],
];

/* =========================
   System prompt
========================= */

$muscleListText = implode(", ", $MUSCLE_GROUPS);

$systemText = <<<SYS
You are MuscleMap Exercise Intake.

Return ONLY valid JSON that matches the schema (no markdown, no extra text).

Rules:
- You are given an existing exercises list (id+name).
- Choose MATCH_EXISTING ONLY if it is essentially identical (same movement, same common name), with very high confidence.
- If it is a variation (machine vs cable, rope vs bar, incline vs flat, angle changes), do NOT match; PROPOSE_NEW instead.
- If critical info is missing, ask ONE question (QUESTION).

IMPORTANT: Muscle group options
- For proposal.weights, ONLY use keys from this allowed list:
  {$muscleListText}
- Weights are 0..1 (0 = not involved, 1 = primary). Use a few keys; do not spam every key.
SYS;

/* =========================
   Build xAI Responses request (proper vision)
========================= */

$userParts = [];

// include text if present
if ($text !== "") {
  $userParts[] = ["type" => "input_text", "text" => "User text: " . $text];
}

// include image properly if present
if ($imageDataUrl !== "") {
  $userParts[] = ["type" => "input_image", "image_url" => $imageDataUrl, "detail" => "high"];
}

// include existing exercises list
$userParts[] = ["type" => "input_text", "text" => "Existing exercises JSON: " . $existingJson];

$payload = [
  "model" => $XAI_MODEL,
  "store" => false,
  "input" => [
    ["role" => "system", "content" => [["type" => "input_text", "text" => $systemText]]],
    ["role" => "user",   "content" => $userParts],
  ],
  "response_format" => $responseFormat,
  "max_output_tokens" => 1200,
];

/* =========================
   Call xAI (Responses API)
========================= */

$ch = curl_init("https://api.x.ai/v1/responses");
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_POST => true,
  CURLOPT_HTTPHEADER => [
    "Authorization: Bearer {$XAI_KEY}",
    "Content-Type: application/json",
    "Accept: application/json",
  ],
  CURLOPT_POSTFIELDS => json_encode($payload),
  CURLOPT_CONNECTTIMEOUT => $XAI_CONNECT_TIMEOUT,
  CURLOPT_TIMEOUT => $XAI_TIMEOUT,
]);

$raw = curl_exec($ch);
$http = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);

if ($raw === false) {
  $err = curl_error($ch);
  curl_close($ch);
  jsonFail(500, "xai_curl_failed", $AI_DEBUG ? ["curl_error" => $err] : []);
}
curl_close($ch);

if ($http < 200 || $http >= 300) {
  jsonFail(500, "xai_http_error", $AI_DEBUG ? ["http" => $http, "raw" => mb_substr($raw, 0, 2000)] : ["http" => $http]);
}

$res = json_decode($raw, true);
if (!is_array($res)) {
  jsonFail(500, "xai_bad_json", $AI_DEBUG ? ["raw" => mb_substr($raw, 0, 2000)] : []);
}

/* =========================
   Extract model output text
========================= */

$jsonText = null;

// 1) output_text shortcut
if (isset($res["output_text"]) && is_string($res["output_text"]) && trim($res["output_text"]) !== "") {
  $jsonText = $res["output_text"];
}

// 2) scan output[].content[] for output_text
if ($jsonText === null) {
  foreach (($res["output"] ?? []) as $out) {
    foreach (($out["content"] ?? []) as $c) {
      if (($c["type"] ?? "") === "output_text" && isset($c["text"])) {
        $jsonText = (string)$c["text"];
        break 2;
      }
    }
  }
}

if (!is_string($jsonText) || trim($jsonText) === "") {
  jsonFail(500, "xai_missing_output_text", $AI_DEBUG ? ["raw" => mb_substr($raw, 0, 2000)] : []);
}

if ($AI_DEBUG) error_log("[MMJ RAW] " . mb_substr($jsonText, 0, 2000));

$jsonText2 = stripJsonFences($jsonText);
$mmj = json_decode($jsonText2, true);

if (!is_array($mmj) || ($mmj["mmj"] ?? null) !== "1") {
  jsonFail(500, "mmj_invalid", $AI_DEBUG ? ["text" => mb_substr($jsonText, 0, 2000)] : []);
}

/* =========================
   Validate action-dependent sections (since schema can't do if/then)
========================= */

$action = (string)($mmj["action"] ?? "");
if ($action === "PROPOSE_NEW") {
  if (!isset($mmj["proposal"]) || !is_array($mmj["proposal"])) {
    $mmj = [
      "mmj" => "1",
      "action" => "QUESTION",
      "message" => "I need one detail to create a new exercise entry.",
      "question" => [
        "id" => "missing_proposal_detail",
        "text" => "What is the exercise name (short), and what muscles does it mainly hit?",
        "type" => "text"
      ]
    ];
  }
} elseif ($action === "MATCH_EXISTING") {
  if (!isset($mmj["match"]) || !is_array($mmj["match"])) {
    $mmj = [
      "mmj" => "1",
      "action" => "QUESTION",
      "message" => "I need one detail to avoid a bad match.",
      "question" => [
        "id" => "same_or_new",
        "text" => "Is this exactly the same as an existing exercise, or a different variation?",
        "type" => "text"
      ]
    ];
  }
} elseif ($action === "QUESTION") {
  if (!isset($mmj["question"]) || !is_array($mmj["question"])) {
    $mmj = [
      "mmj" => "1",
      "action" => "QUESTION",
      "message" => "Ask one question to continue.",
      "question" => [
        "id" => "clarify",
        "text" => "What is the exercise, and what equipment/angle makes it different (if any)?",
        "type" => "text"
      ]
    ];
  }
} elseif ($action === "ERROR") {
  // allow
} else {
  jsonFail(500, "mmj_invalid_action", $AI_DEBUG ? ["action" => $action, "text" => mb_substr($jsonText, 0, 2000)] : []);
}

/* =========================
   Guardrail: MATCH_EXISTING only if VERY close.
========================= */

if (($mmj["action"] ?? "") === "MATCH_EXISTING") {
  $m = $mmj["match"] ?? null;

  $eid  = is_array($m) ? (string)($m["existing_id"] ?? "") : "";
  $conf = is_array($m) ? (float)($m["confidence"] ?? 0.0) : 0.0;

  $foundName = null;
  foreach ($existing as $row) {
    if ((string)($row["id"] ?? "") === $eid) { $foundName = (string)$row["name"]; break; }
  }

  $enameFromModel = is_array($m) ? (string)($m["existing_name"] ?? "") : "";
  $sim = ($foundName !== null) ? nameSimilarity($enameFromModel, $foundName) : 0.0;

  if ($foundName === null || $conf < 0.85 || $sim < 0.78) {
    $mmj = [
      "mmj" => "1",
      "action" => "QUESTION",
      "message" => "Not close enough to safely match. One quick question.",
      "question" => [
        "id" => "confirm_match",
        "text" => "Is this the exact same exercise as \"" . ($foundName ?: $enameFromModel) . "\"? Answer yes/no.",
        "type" => "text"
      ]
    ];
  } else {
    $mmj["match"]["existing_name"] = $foundName;
  }
}

/* =========================
   Clean proposal weights (drop unknown keys + clamp 0..1)
========================= */

if (($mmj["action"] ?? "") === "PROPOSE_NEW" && isset($mmj["proposal"]) && is_array($mmj["proposal"])) {
  if (isset($mmj["proposal"]["weights"]) && is_array($mmj["proposal"]["weights"])) {
    $allowed = array_fill_keys($MUSCLE_GROUPS, true);
    $clean = [];

    foreach ($mmj["proposal"]["weights"] as $k => $v) {
      $k = is_string($k) ? trim($k) : "";
      if ($k === "" || !isset($allowed[$k])) continue;

      if (!is_numeric($v)) continue;
      $num = (float)$v;
      if ($num < 0.0) $num = 0.0;
      if ($num > 1.0) $num = 1.0;
      if ($num > 0.0) $clean[$k] = $num;
    }

    $mmj["proposal"]["weights"] = $clean;

    // if everything got dropped, ask instead of inserting garbage
    if (empty($mmj["proposal"]["weights"])) {
      $mmj = [
        "mmj" => "1",
        "action" => "QUESTION",
        "message" => "I need one detail to map this exercise to your muscle groups.",
        "question" => [
          "id" => "primary_muscles",
          "text" => "Which muscles does this mainly hit? Pick 1–3 from: " . implode(", ", $MUSCLE_GROUPS),
          "type" => "text"
        ]
      ];
    }
  }

  // normalize exercise_key if missing/garbage
  if (($mmj["action"] ?? "") === "PROPOSE_NEW") {
    $ek = $mmj["proposal"]["exercise_key"] ?? "";
    $ek = is_string($ek) ? trim($ek) : "";
    if ($ek === "") {
      $mmj["proposal"]["exercise_key"] = slugSnake((string)($mmj["proposal"]["name"] ?? "exercise"));
    }
  }
}

/* =========================
   Store assistant MMJ
========================= */

$stmt = $pdo->prepare("
  INSERT INTO ai_intake_messages (session_id, role, mmj_json)
  VALUES (?, 'assistant', CAST(? AS JSON))
");
$stmt->execute([$sessionId, json_encode($mmj, JSON_UNESCAPED_SLASHES)]);

$stmt = $pdo->prepare("UPDATE ai_intake_sessions SET last_mmj_json=CAST(? AS JSON) WHERE id=?");
$stmt->execute([json_encode($mmj, JSON_UNESCAPED_SLASHES), $sessionId]);

echo json_encode(["ok" => true, "mmj" => $mmj], JSON_UNESCAPED_SLASHES);
