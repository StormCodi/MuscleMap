<?php
declare(strict_types=1);

require __DIR__ . "/db.php";

$uid = require_user_id();
if ($uid !== 1) json_err("access_denied", 403);

if ($_SERVER["REQUEST_METHOD"] !== "POST") json_err("method_not_allowed", 405);

$raw = file_get_contents("php://input");
$in = json_decode($raw ?: "{}", true);
if (!is_array($in)) $in = [];

$ROOT = realpath(__DIR__ . "/..");
if ($ROOT === false) json_err("server_error", 500);

$script = $ROOT . "/grok_manual_dump.php";
if (!is_file($script) || !is_readable($script)) json_err("script_missing", 500);

$allowedModels = [
  "grok-4-1-fast-reasoning" => true,
  "grok-4-0709" => true,
];

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

$cmd = [
  "php",
  $script,
  "--root=" . $ROOT,
  "--out=" . $out,
  "--model=" . $model,
  "--chunk-tokens=" . (string)$chunkTokens,
  "--max-rounds=" . (string)$maxRounds,
  "--timeout=" . (string)$timeout,
  "--json=1",
];

if ($debug) $cmd[] = "--debug=1";
if ($db) $cmd[] = "--db=1";

if ($useExisting) $cmd[] = "--use-existing-manual=1";

// For chat questions, always use existing manual and append
if ($question !== "") {
  $cmd[] = "--use-existing-manual=1";
  $cmd[] = "--question=" . $question;
}

$descriptors = [
  0 => ["pipe", "r"],
  1 => ["pipe", "w"],
  2 => ["pipe", "w"],
];

$start = microtime(true);
$proc = @proc_open($cmd, $descriptors, $pipes, $ROOT, null, ["bypass_shell" => true]);

if (!is_resource($proc)) json_err("proc_open_failed", 500);

fclose($pipes[0]);

$stdout = stream_get_contents($pipes[1]);
$stderr = stream_get_contents($pipes[2]);
fclose($pipes[1]);
fclose($pipes[2]);

$exitCode = proc_close($proc);
$durMs = (int)round((microtime(true) - $start) * 1000);

$scriptJson = null;
$stdoutTrim = trim((string)$stdout);
if ($stdoutTrim !== "") {
  $scriptJson = json_decode($stdoutTrim, true);
  if (!is_array($scriptJson)) $scriptJson = null;
}

$combined = "";
if (is_string($stdout) && $stdout !== "") $combined .= $stdout;
if (is_string($stderr) && $stderr !== "") {
  if ($combined !== "") $combined .= "\n\n";
  $combined .= "----- STDERR -----\n" . $stderr;
}

// If script returned JSON but ok=false, surface it cleanly
if (is_array($scriptJson) && (($scriptJson["ok"] ?? null) === false)) {
  json_err((string)($scriptJson["error"] ?? "script_failed"), 500, [
    "exit_code" => $exitCode,
    "duration_ms" => $durMs,
    "output" => $combined,
    "script_json" => $scriptJson,
  ]);
}

json_ok([
  "exit_code" => $exitCode,
  "duration_ms" => $durMs,
  "output" => $combined,
  "script_json" => $scriptJson,
  "runner" => [
    "root" => $ROOT,
    "out" => $out,
    "model" => $model,
    "db" => $db,
    "debug" => $debug,
    "use_existing_manual" => $useExisting,
    "question" => ($question !== ""),
  ],
]);
