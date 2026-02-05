<?php
/**
 * grok_manual_dump.php
 * (same header as your current version)
 */
declare(strict_types=1);

/* =========================
   CLI args
========================= */
$args = parseArgs($argv);

$ROOT = rtrim((string)($args['root'] ?? getcwd()), "/");
$outFile = (string)($args['out'] ?? "MANUAL.md");
$model = (string)($args['model'] ?? (getenv("XAI_MODEL") ?: "grok-4-1-fast-reasoning"));

$MAX_FILES = (int)($args['max-files'] ?? 500);
$MAX_TOTAL_BYTES = (int)($args['max-bytes'] ?? 1_800_000);
$DEBUG = ((string)($args['debug'] ?? "0") === "1");

$CHUNK_TOKENS = (int)($args['chunk-tokens'] ?? 12000);
$MAX_ROUNDS   = (int)($args['max-rounds'] ?? 20);
$TIMEOUT      = (int)($args['timeout'] ?? 240);
$CONN_TIMEOUT = (int)($args['connect-timeout'] ?? 20);

$MAX_ATTEMPTS = clampInt(asInt($args['max-attempts'] ?? 3, 3), 1, 50);

$QA_MODE      = ((string)($args['qa'] ?? "0") === "1");
$ONE_QUESTION = trim((string)($args['question'] ?? ""));

$JSON_MODE    = ((string)($args['json'] ?? "0") === "1");

$USE_EXISTING_MANUAL = ((string)($args['use-existing-manual'] ?? "0") === "1");
$MANUAL_PATH_RAW     = trim((string)($args['manual'] ?? ""));

$DB_ENABLE     = ((string)($args['db'] ?? "0") === "1");
$DB_SAMPLE     = max(0, (int)($args['db-sample'] ?? 5));
$DB_MAX_BYTES  = max(0, (int)($args['db-max-bytes'] ?? 250_000));
$DB_CELL_MAX   = max(50, (int)($args['db-cell-max'] ?? 500));
$DB_TABLES_RAW = trim((string)($args['db-tables'] ?? ""));
$DB_ALLOWLIST  = $DB_TABLES_RAW !== "" ? array_values(array_filter(array_map('trim', explode(',', $DB_TABLES_RAW)))) : [];

if (!is_dir($ROOT)) {
  emitError("root dir not found: {$ROOT}", 1, $JSON_MODE);
}

$XAI_KEY = trim((string)getenv("XAI_API_KEY"));
if ($XAI_KEY === "") {
  $XAI_KEY = readSecretFile("/etc/musclemap/xai_api_key") ?? "";
}
if ($XAI_KEY === "") {
  emitError("missing XAI_API_KEY (env) or /etc/musclemap/xai_api_key", 1, $JSON_MODE);
}

if ($JSON_MODE && $QA_MODE && $ONE_QUESTION === "") {
  emitError("json_mode does not support interactive --qa=1. Use --question=\"...\".", 1, $JSON_MODE);
}

/* =========================
   File selection rules
========================= */
$allowedExt = ["php","js","html","css","md","error"];

$excludeDirs = [
  ".git","vendor","node_modules","uploads","uploads/ai_intake","z-anatomy-unity",
  "assets/models","dist","build",".next",".cache",".idea",".vscode","logs","tmp","cache",
];

$excludeFiles = [".env",".env.local",".env.production"];

class SafeRecursiveDirectoryIterator extends RecursiveDirectoryIterator {
  public function hasChildren($allow_links = false): bool {
    try { return parent::hasChildren($allow_links); } catch (Throwable $e) { return false; }
  }
  public function getChildren(): RecursiveDirectoryIterator {
    try { return parent::getChildren(); }
    catch (Throwable $e) { return new RecursiveDirectoryIterator(__DIR__, FilesystemIterator::SKIP_DOTS); }
  }
}

$files = collectFiles($ROOT, $allowedExt, $excludeDirs, $excludeFiles, $MAX_FILES, $MAX_TOTAL_BYTES, $DEBUG);

if (count($files) === 0) emitError("no files collected (check excludes/root)", 1, $JSON_MODE);

fwrite(STDERR, "Collected " . count($files) . " files\n");

$totalBytes = 0;
$docs = [];
foreach ($files as $f) {
  $abs = $f["abs"];
  $rel = $f["rel"];
  $content = safeReadFile($abs);
  if ($content === null) continue;
  $bytes = strlen($content);
  if ($bytes <= 0) continue;

  if ($totalBytes + $bytes > $MAX_TOTAL_BYTES) {
    $remaining = $MAX_TOTAL_BYTES - $totalBytes;
    if ($remaining <= 0) break;
    $content = substr($content, 0, $remaining);
    $bytes = strlen($content);
  }

  $docs[] = ["rel" => $rel, "content" => $content, "bytes" => $bytes];
  $totalBytes += $bytes;
  if ($totalBytes >= $MAX_TOTAL_BYTES) break;
}

fwrite(STDERR, "Total bytes loaded: {$totalBytes}\n");

$allText = "";
foreach ($docs as $d) {
  $allText .= "===== FILE: {$d["rel"]} =====\n{$d["content"]}\n\n";
}

$dbDumpText = "";
if ($DB_ENABLE) {
  fwrite(STDERR, "DB dump: enabled (sample={$DB_SAMPLE}, max_bytes={$DB_MAX_BYTES})\n");
  try {
    $dbDumpText = buildDbDumpTextViaAppDb($ROOT, $DB_SAMPLE, $DB_MAX_BYTES, $DB_CELL_MAX, $DB_ALLOWLIST, $DEBUG);
    if ($dbDumpText !== "") $allText .= "\n\n" . $dbDumpText . "\n\n";
  } catch (Throwable $e) {
    fwrite(STDERR, "WARNING: DB dump failed: " . $e->getMessage() . "\n");
    $allText .= "\n\n===== DB: ERROR =====\n" . $e->getMessage() . "\n\n";
  }
}

$projectContext = <<<TXT
You are generating a developer manual for this project.

Goals:
- Explain what each major file/module does (PHP endpoints, JS modules, pages).
- Explain data model: sessions/messages/images, exercises, logs, muscle state, etc (only if present in code / DB dump).
- Explain request/response flow end-to-end:
  - UI -> JS -> PHP API -> DB -> AI provider -> DB -> UI
- Explain key fields: what each DB field means, what each JSON field means (e.g., mmj schema).
- Explain important invariants and edge cases (permissions, uploads, validation, error codes).
- Provide a "How to extend" section (adding an exercise, adding a muscle group, adding a new endpoint, etc).
- Provide a short troubleshooting section (common errors and where to look).
- Be specific: reference filenames and function names.
- Output markdown.

Constraints:
- Do NOT invent tables/fields not present.
- If something is missing, say "not found in provided files".
TXT;

$absOut = $outFile;
if (!isAbsPath($absOut)) $absOut = $ROOT . "/" . $outFile;

$manualPath = $MANUAL_PATH_RAW !== "" ? $MANUAL_PATH_RAW : $absOut;
if ($MANUAL_PATH_RAW !== "" && !isAbsPath($manualPath)) {
  $manualPath = $ROOT . "/" . ltrim($manualPath, "/");
}

$manualMd = "";
$shouldGenerateManual = !$USE_EXISTING_MANUAL;

if ($USE_EXISTING_MANUAL && !$QA_MODE && $ONE_QUESTION === "") {
  $existing = safeReadFile($manualPath);
  if ($existing === null) emitError("--use-existing-manual=1 but manual not found/readable: {$manualPath}", 1, $JSON_MODE);

  if ($JSON_MODE) {
    echo json_encode([
      "ok" => true, "mode" => "existing",
      "manual_path" => $manualPath, "out_path" => $absOut,
      "model" => $model, "db" => $DB_ENABLE, "debug" => $DEBUG,
      "output" => rtrim($existing) . "\n",
    ], JSON_UNESCAPED_SLASHES);
    exit(0);
  }

  echo rtrim($existing) . "\n";
  exit(0);
}

if ($shouldGenerateManual) {
  $attempts = 0;
  $maxAttempts = $MAX_ATTEMPTS;
  $lastMd = "";
  $retryNudge = "";

  fwrite(STDERR, "Manual generation: max_attempts={$maxAttempts}\n");

  while (true) {
    $attempts++;

    $userPrompt = <<<PROMPT
{$projectContext}
{$retryNudge}

Analyze ONLY these files (and DB dump if present) and generate MANUAL.md.

Requirements for MANUAL.md:
- Title + short overview
- High-level architecture diagram (ASCII is fine)
- Sections:
  1) Directory/Module Map
  2) Data Model (tables + key fields) (only what appears in files / DB dump)
  3) API Endpoints (path, method, request JSON, response JSON, errors)
  4) Frontend Flow (pages, JS modules, how calls happen)
  5) AI Intake / MMJ schema explanation (if present)
  6) How to Extend (new exercise, new endpoint, new muscle group)
  7) Troubleshooting (common errors, logs, permissions, DB)
  8) Q&A (empty starter section with a short note: questions/answers appended over time)

IMPORTANT:
- The manual is NOT acceptable unless it includes section "8) Q&A" (or "## Q&A") at the end.

FILES:
{$allText}
PROMPT;

    $messages = [
      ["role" => "system", "content" => "You are a senior engineer writing internal docs. Produce a complete markdown manual. No extra commentary."],
      ["role" => "user", "content" => $userPrompt],
    ];

    fwrite(STDERR, "Attempt {$attempts}/{$maxAttempts}: calling xAI model={$model} max_tokens={$CHUNK_TOKENS}\n");

    $md = xaiChat($XAI_KEY, $model, $messages, 0.2, $CHUNK_TOKENS, $TIMEOUT, $CONN_TIMEOUT, $DEBUG, $MAX_ROUNDS);
    $md = trim($md) . "\n";
    $lastMd = $md;

    if (manualLooksComplete($md)) {
      fwrite(STDERR, "Attempt {$attempts}: manual looks complete (passed checks)\n");
      $manualMd = $md;
      break;
    }

    fwrite(STDERR, "Attempt {$attempts}: manual incomplete (failed checks)\n");

    if ($attempts >= $maxAttempts) {
      fwrite(STDERR, "WARNING: manual incomplete after {$maxAttempts} attempts; writing last result anyway\n");
      $manualMd = $lastMd;
      break;
    }

    $retryNudge = buildRetryNudge($md);
  }

  if (@file_put_contents($absOut, $manualMd) === false) {
    emitError("failed to write {$absOut}", 1, $JSON_MODE);
  }

  if ($JSON_MODE) {
    echo json_encode([
      "ok" => true, "mode" => "generated",
      "manual_path" => $manualPath, "out_path" => $absOut,
      "model" => $model, "db" => $DB_ENABLE, "debug" => $DEBUG,
      "output" => $manualMd,
    ], JSON_UNESCAPED_SLASHES);
    exit(0);
  }

  echo $manualMd;
} else {
  $existing = safeReadFile($manualPath);
  if ($existing === null) emitError("--use-existing-manual=1 but manual not found/readable: {$manualPath}", 1, $JSON_MODE);
  $manualMd = rtrim($existing) . "\n";
}

if ($ONE_QUESTION !== "" || $QA_MODE) {
  $currentManual = safeReadFile($manualPath) ?? $manualMd;

  if ($ONE_QUESTION !== "") {
    fwrite(STDERR, "Q&A one-shot: answering question (len=" . mb_strlen($ONE_QUESTION) . ")\n");

    $updated = answerAndAppendQA(
      $XAI_KEY, $model, $projectContext, $allText, $currentManual, $ONE_QUESTION,
      $CHUNK_TOKENS, $TIMEOUT, $CONN_TIMEOUT, $DEBUG, $MAX_ROUNDS
    );

    if (@file_put_contents($manualPath, $updated) === false) {
      emitError("failed to write updated manual with Q&A to {$manualPath}", 1, $JSON_MODE);
    }

    $lastBlock = extractLastQaBlock($updated);

    if ($JSON_MODE) {
      echo json_encode([
        "ok" => true, "mode" => "qa_one_shot",
        "manual_path" => $manualPath, "out_path" => $absOut,
        "model" => $model, "db" => $DB_ENABLE, "debug" => $DEBUG,
        "question" => $ONE_QUESTION,
        "output" => $lastBlock,
      ], JSON_UNESCAPED_SLASHES);
      exit(0);
    }

    echo "\n\n" . $lastBlock . "\n";
    exit(0);
  }

  // interactive mode only when not json
  if ($JSON_MODE) {
    emitError("json_mode does not support interactive qa loop; use --question", 1, $JSON_MODE);
  }

  fwrite(STDERR, "\nQ&A mode. Type a question and press Enter.\n");
  fwrite(STDERR, "Commands: 'exit' / 'quit' to stop, blank line to stop.\n\n");
  fwrite(STDERR, "Manual path: {$manualPath}\n\n");

  while (true) {
    fwrite(STDERR, "> ");
    $line = fgets(STDIN);
    if ($line === false) break;

    $q = trim($line);
    if ($q === "") break;
    if (in_array(strtolower($q), ["exit","quit"], true)) break;

    $currentManual = safeReadFile($manualPath) ?? $currentManual;

    $updated = answerAndAppendQA(
      $XAI_KEY, $model, $projectContext, $allText, $currentManual, $q,
      $CHUNK_TOKENS, $TIMEOUT, $CONN_TIMEOUT, $DEBUG, $MAX_ROUNDS
    );

    if (@file_put_contents($manualPath, $updated) === false) {
      fwrite(STDERR, "ERROR: failed to write updated manual with Q&A to {$manualPath}\n");
      break;
    }

    $currentManual = $updated;
    echo "\n" . extractLastQaBlock($updated) . "\n";
  }
}

exit(0);

/* =========================
   Helpers
========================= */

function emitError(string $msg, int $code, bool $jsonMode): void {
  if ($jsonMode) {
    echo json_encode(["ok" => false, "error" => $msg], JSON_UNESCAPED_SLASHES);
    exit($code);
  }
  fwrite(STDERR, "ERROR: {$msg}\n");
  exit($code);
}

function parseArgs(array $argv): array {
  $out = [];
  foreach ($argv as $i => $a) {
    if ($i === 0) continue;
    if (substr($a, 0, 2) !== "--") continue;
    $a = substr($a, 2);
    $parts = explode("=", $a, 2);
    $k = trim($parts[0]);
    $v = $parts[1] ?? "1";
    if ($k !== "") $out[$k] = $v;
  }
  return $out;
}

function readSecretFile(string $path): ?string {
  if (!is_readable($path)) return null;
  $s = @file_get_contents($path);
  if ($s === false) return null;
  $s = trim($s);
  return $s !== "" ? $s : null;
}

function isAbsPath(string $p): bool {
  if ($p === "") return false;
  if ($p[0] === "/") return true;
  return (bool)preg_match('/^[A-Za-z]:\\\\/', $p);
}

function asInt($v, int $def): int {
  if (is_int($v)) return $v;
  if (is_string($v) && preg_match('/^-?\d+$/', $v)) return (int)$v;
  return $def;
}

function clampInt(int $v, int $min, int $max): int {
  if ($v < $min) return $min;
  if ($v > $max) return $max;
  return $v;
}

function pathRel(string $abs, string $root): string {
  $root = rtrim($root, "/") . "/";
  $absN = str_replace("\\", "/", $abs);
  $rootN = str_replace("\\", "/", $root);
  if (strpos($absN, $rootN) === 0) return ltrim(substr($absN, strlen($rootN)), "/");
  return ltrim($absN, "/");
}

function shouldExcludeRel(string $rel, array $excludeDirs, array $excludeFiles): bool {
  $rel = str_replace("\\", "/", $rel);
  $relTrim = trim($rel, "/");

  $base = basename($relTrim);
  foreach ($excludeFiles as $xf) if ($base === $xf) return true;

  foreach ($excludeDirs as $xd) {
    $xd = trim(str_replace("\\", "/", $xd), "/");
    if ($xd === "") continue;
    if ($relTrim === $xd) return true;
    if (strpos($relTrim . "/", $xd . "/") === 0) return true;
  }
  return false;
}

class SafeRecursiveDirectoryIterator extends RecursiveDirectoryIterator {
  public function hasChildren($allow_links = false): bool {
    try { return parent::hasChildren($allow_links); } catch (Throwable $e) { return false; }
  }
  public function getChildren(): RecursiveDirectoryIterator {
    try { return parent::getChildren(); }
    catch (Throwable $e) { return new RecursiveDirectoryIterator(__DIR__, FilesystemIterator::SKIP_DOTS); }
  }
}

function collectFiles(
  string $root,
  array $allowedExt,
  array $excludeDirs,
  array $excludeFiles,
  int $maxFiles,
  int $maxTotalBytes,
  bool $debug
): array {
  $files = [];
  $itFlags = FilesystemIterator::SKIP_DOTS;
  $dirIt = new SafeRecursiveDirectoryIterator($root, $itFlags);

  $filter = new RecursiveCallbackFilterIterator(
    $dirIt,
    function ($current) use ($root, $excludeDirs, $excludeFiles, $allowedExt) {
      if (!($current instanceof SplFileInfo)) return false;

      $abs = $current->getPathname();
      $rel = str_replace("\\", "/", pathRel($abs, $root));

      if ($current->isDir()) {
        if (shouldExcludeRel($rel, $excludeDirs, $excludeFiles)) return false;
        if (!$current->isReadable()) return false;
        return true;
      }

      if (shouldExcludeRel($rel, $excludeDirs, $excludeFiles)) return false;
      if (!$current->isReadable()) return false;

      $ext = strtolower(pathinfo($rel, PATHINFO_EXTENSION));
      if ($ext === "" && strtolower(basename($rel)) === ".htaccess") $ext = "htaccess";

      return in_array($ext, $allowedExt, true);
    }
  );

  $rii = new RecursiveIteratorIterator($filter, RecursiveIteratorIterator::LEAVES_ONLY);
  $estimatedBytes = 0;

  foreach ($rii as $fileInfo) {
    /** @var SplFileInfo $fileInfo */
    if (!$fileInfo->isFile()) continue;
    if (!$fileInfo->isReadable()) continue;

    $abs = $fileInfo->getPathname();
    $rel = str_replace("\\", "/", pathRel($abs, $root));
    $size = (int)($fileInfo->getSize() ?: 0);

    if ($estimatedBytes + $size > $maxTotalBytes * 2) continue;

    $files[] = ["abs" => $abs, "rel" => $rel, "size" => $size];
    $estimatedBytes += $size;

    if (count($files) >= $maxFiles) break;
  }

  usort($files, fn($a,$b) => strcmp($a["rel"], $b["rel"]));
  if ($debug) fwrite(STDERR, "Estimated bytes (sizes): {$estimatedBytes}\n");
  return $files;
}

function safeReadFile(string $abs): ?string {
  if (!is_file($abs) || !is_readable($abs)) return null;
  $s = @file_get_contents($abs);
  if ($s === false) return null;
  return str_replace("\r\n", "\n", $s);
}

/* =========================
   DB dump via api/db.php
========================= */

function buildDbDumpTextViaAppDb(
  string $root,
  int $sampleRows,
  int $maxBytes,
  int $cellMax,
  array $allowlist,
  bool $debug
): string {
  $pdo = getAppPdoFromApiDb($root);

  $tables = [];
  foreach ($pdo->query("SHOW TABLES") as $row) $tables[] = (string)array_values($row)[0];
  sort($tables);

  if ($allowlist) {
    $allow = array_flip($allowlist);
    $tables = array_values(array_filter($tables, fn($t) => isset($allow[$t])));
  }

  $out = "===== DB: SCHEMA + SAMPLE ROWS (via api/db.php) =====\n";
  $out .= "NOTE: Sample rows are limited; long values truncated.\n\n";
  $bytes = strlen($out);

  foreach ($tables as $t) {
    $section = "";

    $stmt = $pdo->query("SHOW CREATE TABLE `{$t}`");
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    $createSql = "";
    if ($row) {
      foreach ($row as $k => $v) {
        if (stripos($k, "Create Table") !== false) { $createSql = (string)$v; break; }
      }
    }

    $section .= "===== DB: SHOW_CREATE_TABLE {$t} =====\n";
    $section .= $createSql !== "" ? ($createSql . "\n\n") : "(not found)\n\n";

    $section .= "===== DB: FULL_COLUMNS {$t} =====\n";
    $cols = $pdo->query("SHOW FULL COLUMNS FROM `{$t}`")->fetchAll(PDO::FETCH_ASSOC);
    $section .= renderRowsAsMarkdownTable($cols, $cellMax) . "\n\n";

    $section .= "===== DB: INDEXES {$t} =====\n";
    $idx = $pdo->query("SHOW INDEX FROM `{$t}`")->fetchAll(PDO::FETCH_ASSOC);
    $section .= renderRowsAsMarkdownTable($idx, $cellMax) . "\n\n";

    if ($sampleRows > 0) {
      $section .= "===== DB: SAMPLE_ROWS {$t} (LIMIT {$sampleRows}) =====\n";
      $rows = $pdo->query("SELECT * FROM `{$t}` LIMIT {$sampleRows}")->fetchAll(PDO::FETCH_ASSOC);
      $section .= renderRowsAsMarkdownTable($rows, $cellMax) . "\n\n";
    }

    if ($bytes + strlen($section) > $maxBytes) {
      if ($debug) fwrite(STDERR, "DB dump hit cap at table {$t}\n");
      $out .= "===== DB: TRUNCATED =====\nReached --db-max-bytes cap.\n";
      break;
    }

    $out .= $section;
    $bytes = strlen($out);
  }

  return $out;
}

function getAppPdoFromApiDb(string $root): PDO {
  $path = rtrim($root, "/") . "/api/db.php";
  if (!is_readable($path)) throw new RuntimeException("Cannot read api/db.php at: {$path}");

  require_once $path;

  if (isset($GLOBALS['pdo']) && $GLOBALS['pdo'] instanceof PDO) return $GLOBALS['pdo'];

  if (function_exists('db')) {
    $pdo = db();
    if ($pdo instanceof PDO) return $pdo;
  }
  if (function_exists('get_pdo')) {
    $pdo = get_pdo();
    if ($pdo instanceof PDO) return $pdo;
  }

  throw new RuntimeException("api/db.php did not expose a PDO. Expected \$GLOBALS['pdo'] or db()/get_pdo().");
}

function renderRowsAsMarkdownTable(array $rows, int $cellMax): string {
  if (!$rows) return "(no rows)\n";
  $cols = [];
  foreach ($rows as $r) foreach (array_keys($r) as $k) $cols[$k] = true;
  $cols = array_keys($cols);

  $out = "| " . implode(" | ", array_map('escapeMd', $cols)) . " |\n";
  $out .= "| " . implode(" | ", array_fill(0, count($cols), "---")) . " |\n";

  foreach ($rows as $r) {
    $vals = [];
    foreach ($cols as $c) {
      $v = $r[$c] ?? null;
      if ($v === null) $s = "NULL";
      elseif (is_bool($v)) $s = $v ? "1" : "0";
      else $s = (string)$v;
      $s = normalizeWhitespace($s);
      if (mb_strlen($s) > $cellMax) $s = mb_substr($s, 0, $cellMax) . "…";
      $vals[] = escapeMd($s);
    }
    $out .= "| " . implode(" | ", $vals) . " |\n";
  }
  return $out;
}

function normalizeWhitespace(string $s): string {
  $s = str_replace(["\r\n", "\r"], "\n", $s);
  $s = preg_replace("/[ \t]+/", " ", $s) ?? $s;
  $s = preg_replace("/\n{3,}/", "\n\n", $s) ?? $s;
  return trim($s);
}

function escapeMd(string $s): string {
  return str_replace("|", "\\|", $s);
}

/* =========================
   Manual completeness checks
========================= */

function manualLooksComplete(string $md): bool {
  $md = trim($md);
  if ($md === "") return false;

  $hasQa =
    (bool)preg_match('/^##\s*8\)\s*Q&A\s*$/mi', $md) ||
    (bool)preg_match('/^##\s*Q&A\s*$/mi', $md);

  if (!$hasQa) return false;

  for ($i = 1; $i <= 7; $i++) {
    $ok = (bool)preg_match('/^##\s*' . preg_quote((string)$i, '/') . '\)\s+/m', $md);
    if (!$ok) return false;
  }
  return true;
}

function buildRetryNudge(string $md): string {
  $missing = [];
  for ($i = 1; $i <= 8; $i++) {
    $has = (bool)preg_match('/^##\s*' . preg_quote((string)$i, '/') . '\)\s+/m', $md);
    if (!$has) $missing[] = $i;
  }
  if (!$missing && !preg_match('/^##\s*Q&A\s*$/mi', $md)) $missing[] = 8;
  if (!$missing) return "";

  $list = implode(", ", $missing);
  return "\n\nIMPORTANT: Your last output was incomplete. Missing section numbers detected: {$list}. ".
         "Regenerate the FULL manual from scratch and include sections 1) through 8) with 8) Q&A at the end.\n";
}

/* =========================
   Q&A helpers
========================= */

function ensureQaSectionExists(string $manual): string {
  if (preg_match('/^##\s+Q&A\s*$/mi', $manual)) return rtrim($manual) . "\n";
  $manual = rtrim($manual) . "\n\n";
  $manual .= "## Q&A\n\n";
  $manual .= "_Questions and answers are appended here over time._\n";
  return rtrim($manual) . "\n";
}

function extractLastQaBlock(string $manual): string {
  $m = [];
  if (!preg_match_all('/^###\s+Q:\s.*$/m', $manual, $m, PREG_OFFSET_CAPTURE)) return "";
  $last = end($m[0]);
  $pos = (int)$last[1];
  return trim(substr($manual, $pos));
}

function answerAndAppendQA(
  string $apiKey,
  string $model,
  string $projectContext,
  string $allFilesText,
  string $currentManual,
  string $question,
  int $chunkTokens,
  int $timeoutSec,
  int $connectTimeoutSec,
  bool $debug,
  int $maxRounds
): string {
  $currentManual = ensureQaSectionExists($currentManual);

  $qaPrompt = <<<PROMPT
{$projectContext}

You are answering a developer question about this project.
You MUST base your answer ONLY on the provided files/DB dump and the current manual text.
If the answer is not supported by the files, say so and point to what you'd inspect next.

Output requirements:
- Return ONLY the markdown content that should be appended under "## Q&A" as a single Q&A entry.
- Do not repeat the whole manual.
- Format exactly:
  ### Q: <question>
  <answer>

Current manual (context; do not rewrite it):
===== MANUAL.md (current) =====
{$currentManual}

Project files and DB dump (authoritative):
{$allFilesText}

Question:
{$question}
PROMPT;

  $messages = [
    ["role" => "system", "content" => "You are a senior engineer answering internal dev questions using only the provided project sources. Output only the Q&A entry in markdown. No extra commentary."],
    ["role" => "user", "content" => $qaPrompt],
  ];

  $qaEntry = xaiChat(
    $apiKey,
    $model,
    $messages,
    0.2,
    $chunkTokens,
    $timeoutSec,
    $connectTimeoutSec,
    $debug,
    $maxRounds
  );

  $qaEntry = trim($qaEntry);
  if (!preg_match('/^###\s+Q:\s+/i', $qaEntry)) {
    $qaEntry = "### Q: " . trim($question) . "\n\n" . trim($qaEntry);
  }

  $updated = rtrim($currentManual) . "\n\n" . $qaEntry . "\n";
  return rtrim($updated) . "\n";
}

/* =========================
   xAI chat
========================= */

function xaiChat(
  string $apiKey,
  string $model,
  array $messages,
  float $temperature = 0.2,
  int $chunkTokens = 12000,
  int $timeoutSec = 240,
  int $connectTimeoutSec = 15,
  bool $debug = false,
  int $maxRounds = 20
): string {
  $full = "";
  $round = 0;

  while (true) {
    $round++;
    if ($round > $maxRounds) {
      if ($debug) fwrite(STDERR, "Reached max continuation rounds ({$maxRounds}). Stopping.\n");
      break;
    }

    $payload = [
      "model" => $model,
      "messages" => $messages,
      "temperature" => $temperature,
      "max_tokens" => $chunkTokens,
    ];

    $ch = curl_init("https://api.x.ai/v1/chat/completions");
    curl_setopt_array($ch, [
      CURLOPT_RETURNTRANSFER => true,
      CURLOPT_POST => true,
      CURLOPT_HTTPHEADER => [
        "Authorization: Bearer {$apiKey}",
        "Content-Type: application/json",
        "Accept: application/json",
      ],
      CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_SLASHES),
      CURLOPT_CONNECTTIMEOUT => $connectTimeoutSec,
      CURLOPT_TIMEOUT => $timeoutSec,
    ]);

    $raw = curl_exec($ch);
    $http = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);

    if ($raw === false) {
      $err = curl_error($ch);
      $eno = curl_errno($ch);
      curl_close($ch);
      throw new RuntimeException("xai_curl_failed errno={$eno} err={$err}");
    }
    curl_close($ch);

    if ($http < 200 || $http >= 300) {
      if ($debug) fwrite(STDERR, "xAI HTTP {$http}\n{$raw}\n");
      throw new RuntimeException("xai_http_error http={$http}");
    }

    $res = json_decode($raw, true);
    if (!is_array($res)) throw new RuntimeException("xai_bad_json");

    $choice = $res["choices"][0] ?? null;
    if (!is_array($choice)) throw new RuntimeException("xai_missing_choice");

    $content = (string)($choice["message"]["content"] ?? "");
    $finish  = (string)($choice["finish_reason"] ?? "unknown");

    if ($debug) fwrite(STDERR, "Round {$round}: finish_reason={$finish}, bytes=" . strlen($content) . "\n");

    if ($content !== "") $full .= $content;
    if ($finish !== "length") break;

    $messages[] = ["role" => "assistant", "content" => $content];
    $messages[] = ["role" => "user", "content" => "Continue exactly where you left off. Do not repeat anything already written."];
  }

  return trim($full) . "\n";
}
