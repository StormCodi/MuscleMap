<?php
declare(strict_types=1);

require __DIR__ . "/db.php";

$uid = require_user_id();
if ($uid !== 1) json_err("access_denied", 403);

$ROOT = realpath(__DIR__ . "/..");
if ($ROOT === false) json_err("server_error", 500);

$RUN_BASE = "/tmp/mm_manual_runs";
if (!is_dir($RUN_BASE)) {
  @mkdir($RUN_BASE, 0770, true);
}

function asInt($v, int $def): int {
  if (is_int($v)) return $v;
  if (is_string($v) && preg_match('/^-?\d+$/', $v)) return (int)$v;
  return $def;
}
function asBool01($v): int {
  if ($v === true) return 1;
  if ($v === false) return 0;
  if (is_int($v)) return $v ? 1 : 0;
  if (is_string($v)) return ($v === "1" || strtolower($v) === "true") ? 1 : 0;
  return 0;
}
function clampInt(int $v, int $min, int $max): int {
  if ($v < $min) return $min;
  if ($v > $max) return $max;
  return $v;
}
function safeRelOut(string $p): string {
  $p = trim(str_replace("\\", "/", $p));
  if ($p === "") return "MANUAL.md";
  if (strpos($p, "..") !== false) return "MANUAL.md";
  if (!preg_match('/^[A-Za-z0-9._-]+\.md$/', basename($p))) return "MANUAL.md";
  return basename($p);
}
function safeRunId(string $s): string {
  $s = trim($s);
  if (!preg_match('/^[A-Za-z0-9_-]{8,80}$/', $s)) return "";
  return $s;
}
function tailFile(string $path, int $maxBytes): string {
  if (!is_file($path) || !is_readable($path)) return "";
  $size = @filesize($path);
  if (!is_int($size) || $size <= 0) return "";
  $read = min($maxBytes, $size);
  $fh = @fopen($path, "rb");
  if (!$fh) return "";
  @fseek($fh, -$read, SEEK_END);
  $data = @fread($fh, $read);
  @fclose($fh);
  if ($data === false) return "";
  // normalize newlines a bit
  return str_replace("\r\n", "\n", $data);
}

function runDir(string $base, string $runId): string {
  return rtrim($base, "/") . "/" . $runId;
}

function mkRunId(): string {
  $t = (string)time();
  $r = bin2hex(random_bytes(8));
  return "run_" . $t . "_" . $r;
}

/**
 * Status endpoint (GET ?status=1&run_id=...)
 */
if ($_SERVER["REQUEST_METHOD"] === "GET" && isset($_GET["status"])) {
  $runId = safeRunId((string)($_GET["run_id"] ?? ""));
  if ($runId === "") json_err("bad_run_id", 400);

  $dir = runDir($RUN_BASE, $runId);
  $metaPath = $dir . "/meta.json";
  $stdoutPath = $dir . "/stdout.json";
  $stderrPath = $dir . "/stderr.log";
  $exitPath = $dir . "/exit_code.txt";

  if (!is_file($metaPath)) json_err("run_not_found", 404);

  $metaRaw = @file_get_contents($metaPath);
  $meta = json_decode($metaRaw ?: "{}", true);
  if (!is_array($meta)) $meta = [];

  $running = !is_file($exitPath);

  $stderrTail = tailFile($stderrPath, 16000);
  $stdoutTail = tailFile($stdoutPath, 6000); // JSON is huge; only a bit
  $tail = "";
  if ($stderrTail !== "") {
    $tail .= "----- STDERR (tail) -----\n" . $stderrTail;
  }
  if ($stdoutTail !== "") {
    if ($tail !== "") $tail .= "\n\n";
    $tail .= "----- STDOUT (tail) -----\n" . $stdoutTail;
  }
  if ($tail === "") $tail = "(no output yet)";

  if ($running) {
    json_ok([
      "running" => true,
      "tail" => $tail,
    ]);
  }

  $exitCode = null;
  $exitRaw = @file_get_contents($exitPath);
  if ($exitRaw !== false) {
    $exitRaw = trim($exitRaw);
    if ($exitRaw !== "" && preg_match('/^-?\d+$/', $exitRaw)) $exitCode = (int)$exitRaw;
  }

  // Read full stdout (JSON) but cap what we send back
  $stdoutFull = @file_get_contents($stdoutPath);
  if ($stdoutFull === false) $stdoutFull = "";
  $stdoutTrim = trim($stdoutFull);

  $scriptJson = null;
  if ($stdoutTrim !== "") {
    $tmp = json_decode($stdoutTrim, true);
    if (is_array($tmp)) $scriptJson = $tmp;
  }

  $stderrFull = @file_get_contents($stderrPath);
  if ($stderrFull === false) $stderrFull = "";

  $finalCombined = "";
  if ($stdoutFull !== "") $finalCombined .= $stdoutFull;
  if ($stderrFull !== "") {
    if ($finalCombined !== "") $finalCombined .= "\n\n";
    $finalCombined .= "----- STDERR -----\n" . $stderrFull;
  }

  // cap final output returned to browser (avoid huge responses)
  $CAP = 220000; // ~220KB
  if (strlen($finalCombined) > $CAP) {
    $finalCombined = substr($finalCombined, -$CAP);
    $finalCombined = "(output truncated; showing last " . $CAP . " bytes)\n\n" . $finalCombined;
  }

  $doneOk = ($exitCode === 0) && is_array($scriptJson) && (($scriptJson["ok"] ?? null) === true);

  json_ok([
    "running" => false,
    "exit_code" => $exitCode,
    "done_ok" => $doneOk,
    "tail" => $tail,
    "final_output" => $finalCombined,
    "script_json" => $scriptJson,
    "runner" => [
      "root" => $meta["root"] ?? $ROOT,
      "out" => $meta["out"] ?? null,
      "model" => $meta["model"] ?? null,
      "db" => $meta["db"] ?? null,
      "debug" => $meta["debug"] ?? null,
      "use_existing_manual" => $meta["use_existing_manual"] ?? null,
      "question" => $meta["question"] ?? null,
      "max_attempts" => $meta["max_attempts"] ?? null,
    ],
  ]);
}

/**
 * POST: start async run
 */
if ($_SERVER["REQUEST_METHOD"] !== "POST") json_err("method_not_allowed", 405);

$raw = file_get_contents("php://input");
$in = json_decode($raw ?: "{}", true);
if (!is_array($in)) $in = [];

$script = $ROOT . "/grok_manual_dump.php";
if (!is_file($script) || !is_readable($script)) json_err("script_missing", 500);

$allowedModels = [
  "grok-4-1-fast-reasoning" => true,
  "grok-4-0709" => true,
];

$model = (string)($in["model"] ?? "grok-4-1-fast-reasoning");
if (!isset($allowedModels[$model])) $model = "grok-4-1-fast-reasoning";

$out = safeRelOut((string)($in["out"] ?? "MANUAL.md"));

$debug = asBool01($in["debug"] ?? 0);
$db = asBool01($in["db"] ?? 0);

$useExisting = asBool01($in["use_existing_manual"] ?? 1);
$question = trim((string)($in["question"] ?? ""));
if ($question !== "") {
  if (mb_strlen($question) > 2000) $question = mb_substr($question, 0, 2000);
  $question = str_replace("\0", "", $question);
}

$chunkTokens = clampInt(asInt($in["chunk_tokens"] ?? 12000, 12000), 1000, 50000);
$maxRounds   = clampInt(asInt($in["max_rounds"] ?? 20, 20), 1, 100);
$timeout     = clampInt(asInt($in["timeout"] ?? 240, 240), 5, 1800);
$maxAttempts = clampInt(asInt($in["max_attempts"] ?? 3, 3), 1, 50);

$startAsync = asBool01($in["start_async"] ?? 0);
if ($startAsync !== 1) {
  // Keep behavior strict: this endpoint is now async-only from the admin UI.
  // If you want sync again, you can re-add it, but async is needed for live output.
  json_err("start_async_required", 400);
}

$cmdParts = [
  "php",
  $script,
  "--root=" . $ROOT,
  "--out=" . $out,
  "--model=" . $model,
  "--chunk-tokens=" . (string)$chunkTokens,
  "--max-rounds=" . (string)$maxRounds,
  "--timeout=" . (string)$timeout,
  "--max-attempts=" . (string)$maxAttempts,
  "--json=1",
];

if ($debug) $cmdParts[] = "--debug=1";
if ($db) $cmdParts[] = "--db=1";

if ($useExisting) $cmdParts[] = "--use-existing-manual=1";

// For chat questions, always use existing manual and append
if ($question !== "") {
  $cmdParts[] = "--use-existing-manual=1";
  $cmdParts[] = "--question=" . $question;
}

$runId = mkRunId();
$dir = runDir($RUN_BASE, $runId);
if (!@mkdir($dir, 0770, true)) json_err("run_dir_create_failed", 500);

$stdoutPath = $dir . "/stdout.json";
$stderrPath = $dir . "/stderr.log";
$exitPath   = $dir . "/exit_code.txt";
$metaPath   = $dir . "/meta.json";

$cmdStr = implode(" ", array_map("escapeshellarg", $cmdParts));

// Run in background, write stdout/stderr/exit code into files.
$inner = "cd " . escapeshellarg($ROOT) .
  " && " . $cmdStr .
  " > " . escapeshellarg($stdoutPath) .
  " 2> " . escapeshellarg($stderrPath) .
  "; echo \\$? > " . escapeshellarg($exitPath);

$bash = "bash -lc " . escapeshellarg($inner) . " > /dev/null 2>&1 & echo $!";

$pidStr = @shell_exec($bash);
$pid = is_string($pidStr) ? (int)trim($pidStr) : 0;

$meta = [
  "run_id" => $runId,
  "pid" => $pid,
  "root" => $ROOT,
  "out" => $out,
  "model" => $model,
  "db" => (bool)$db,
  "debug" => (bool)$debug,
  "use_existing_manual" => (bool)$useExisting,
  "question" => ($question !== "" ? $question : null),
  "chunk_tokens" => $chunkTokens,
  "max_rounds" => $maxRounds,
  "timeout" => $timeout,
  "max_attempts" => $maxAttempts,
  "started_at" => date("c"),
  "cmd" => $cmdParts,
];

@file_put_contents($metaPath, json_encode($meta, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT));

json_ok([
  "run_id" => $runId,
  "pid" => $pid,
]);
