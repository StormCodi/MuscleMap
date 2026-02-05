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
function runDir(string $base, string $runId): string {
  return rtrim($base, "/") . "/" . $runId;
}
function mkRunId(): string {
  $t = (string)time();
  $r = bin2hex(random_bytes(8));
  return "run_" . $t . "_" . $r;
}

/**
 * Read file append from offset. Returns [appendString, newOffset].
 */
function readAppend(string $path, int $offset, int $maxBytes): array {
  if (!is_file($path) || !is_readable($path)) return ["", $offset];
  $size = @filesize($path);
  if (!is_int($size) || $size < 0) return ["", $offset];
  if ($offset < 0) $offset = 0;
  if ($offset > $size) $offset = $size;

  $toRead = $size - $offset;
  if ($toRead <= 0) return ["", $offset];

  $toRead = min($toRead, $maxBytes);

  $fh = @fopen($path, "rb");
  if (!$fh) return ["", $offset];
  @fseek($fh, $offset, SEEK_SET);
  $data = @fread($fh, $toRead);
  @fclose($fh);

  if ($data === false) $data = "";
  $newOff = $offset + strlen($data);
  return [str_replace("\r\n", "\n", $data), $newOff];
}

/**
 * Status endpoint (GET ?status=1&run_id=...&stderr_off=&stdout_off=...)
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

  $running = !is_file($exitPath);

  $stderrOff = asInt($_GET["stderr_off"] ?? 0, 0);
  $stdoutOff = asInt($_GET["stdout_off"] ?? 0, 0);

  // stream some append content each poll
  $CAP_APPEND = 18000;

  [$stderrAppend, $stderrNew] = readAppend($stderrPath, $stderrOff, $CAP_APPEND);
  [$stdoutAppend, $stdoutNew] = readAppend($stdoutPath, $stdoutOff, (int)($CAP_APPEND * 0.5)); // stdout json can be huge

  $append = "";
  if ($stderrAppend !== "") $append .= $stderrAppend;
  if ($stdoutAppend !== "") {
    if ($append !== "" && !str_ends_with($append, "\n")) $append .= "\n";
    $append .= $stdoutAppend;
  }

  if ($running) {
    json_ok([
      "running" => true,
      "append" => $append,
      "stderr_off" => $stderrNew,
      "stdout_off" => $stdoutNew,
    ]);
  }

  // done
  $exitCode = null;
  $exitRaw = @file_get_contents($exitPath);
  if ($exitRaw !== false) {
    $exitRaw = trim($exitRaw);
    if ($exitRaw !== "" && preg_match('/^-?\d+$/', $exitRaw)) $exitCode = (int)$exitRaw;
  }

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

  $CAP = 220000;
  if (strlen($finalCombined) > $CAP) {
    $finalCombined = substr($finalCombined, -$CAP);
    $finalCombined = "(output truncated; showing last " . $CAP . " bytes)\n\n" . $finalCombined;
  }

  $doneOk = ($exitCode === 0) && is_array($scriptJson) && (($scriptJson["ok"] ?? null) === true);

  $metaRaw = @file_get_contents($metaPath);
  $meta = json_decode($metaRaw ?: "{}", true);
  if (!is_array($meta)) $meta = [];

  json_ok([
    "running" => false,
    "exit_code" => $exitCode,
    "done_ok" => $doneOk,
    "append" => $append,
    "stderr_off" => $stderrNew,
    "stdout_off" => $stdoutNew,
    "final_output" => $finalCombined,
    "script_json" => $scriptJson,
    "runner" => [
      "root" => $meta["root"] ?? $ROOT,
      "out" => $meta["out"] ?? null,
      "model" => $meta["model"] ?? null,
      "db" => $meta["db"] ?? null,
      "debug" => $meta["debug"] ?? null,
      "allow_sql" => $meta["allow_sql"] ?? null,
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
$allowSql = asBool01($in["allow_sql"] ?? 0);

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
if ($startAsync !== 1) json_err("start_async_required", 400);

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
if ($allowSql) $cmdParts[] = "--allow-sql=1";

// For chat questions: always use existing manual and append Q&A
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
  "allow_sql" => (bool)$allowSql,
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
