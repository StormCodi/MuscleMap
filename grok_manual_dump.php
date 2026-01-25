<?php
/**
 * grok_manual_dump.php
 *
 * Crawl project source files, send them to xAI (Grok), and generate a developer manual.
 * (UNCHUNKED: sends all collected files in ONE request)
 *
 * Usage:
 *   sudo php grok_manual_dump.php --out=MANUAL.md
 *
 * Optional:
 *   --root=/var/www/html/musclemap
 *   --model=grok-4-0709
 *   --max-files=500
 *   --max-bytes=1800000
 *   --debug=1
 */

declare(strict_types=1);

/* =========================
   CLI args
========================= */
$args = parseArgs($argv);

$ROOT = rtrim($args['root'] ?? getcwd(), "/");
$outFile = $args['out'] ?? "MANUAL.md";
$model = $args['model'] ?? (getenv("XAI_MODEL") ?: "grok-4-0709");

$MAX_FILES = (int)($args['max-files'] ?? 500);
$MAX_TOTAL_BYTES = (int)($args['max-bytes'] ?? 1_800_000);
$DEBUG = ((string)($args['debug'] ?? "0") === "1");

if (!is_dir($ROOT)) {
  fwrite(STDERR, "ERROR: root dir not found: {$ROOT}\n");
  exit(1);
}

/* =========================
   xAI key (env or /etc)
========================= */
$XAI_KEY = trim((string)getenv("XAI_API_KEY"));
if ($XAI_KEY === "") {
  $XAI_KEY = readSecretFile("/etc/musclemap/xai_api_key") ?? "";
}
if ($XAI_KEY === "") {
  fwrite(STDERR, "ERROR: missing XAI_API_KEY (env) or /etc/musclemap/xai_api_key\n");
  exit(1);
}

/* =========================
   File selection rules
========================= */
$allowedExt = [
  "php","js",
  "html","css",
];

$excludeDirs = [
  ".git",
  "vendor",
  "node_modules",
  "uploads",
  "uploads/ai_intake",
  "z-anatomy-unity",
  "assets/models",
  "dist",
  "build",
  ".next",
  ".cache",
  ".idea",
  ".vscode",
  "logs",
  "tmp",
  "cache",
];

$excludeFiles = [
  ".env",
  ".env.local",
  ".env.production",
];

/* =========================
   Safe iterator (avoid permission death)
========================= */
class SafeRecursiveDirectoryIterator extends RecursiveDirectoryIterator {
  public function hasChildren($allow_links = false): bool {
    try { return parent::hasChildren($allow_links); }
    catch (Throwable $e) { return false; }
  }
  public function getChildren(): RecursiveDirectoryIterator {
    try { return parent::getChildren(); }
    catch (Throwable $e) { return new RecursiveDirectoryIterator(__DIR__, FilesystemIterator::SKIP_DOTS); }
  }
}

/* =========================
   Collect files
========================= */
$files = collectFiles($ROOT, $allowedExt, $excludeDirs, $excludeFiles, $MAX_FILES, $MAX_TOTAL_BYTES, $DEBUG);

if (count($files) === 0) {
  fwrite(STDERR, "ERROR: no files collected (check excludes/root)\n");
  exit(1);
}

if ($DEBUG) fwrite(STDERR, "Collected " . count($files) . " files\n");

/* =========================
   Read file contents (bounded)
========================= */
$totalBytes = 0;
$docs = [];

foreach ($files as $f) {
  $abs = $f["abs"];
  $rel = $f["rel"];

  $content = safeReadFile($abs);
  if ($content === null) continue;

  if (looksLikeSecret($rel, $content)) {
    if ($DEBUG) fwrite(STDERR, "Skipping likely-secret file: {$rel}\n");
    continue;
  }

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

if ($DEBUG) fwrite(STDERR, "Total bytes loaded: {$totalBytes}\n");

/* =========================
   Grok prompt (single-shot)
========================= */
$projectContext = <<<TXT
You are generating a developer manual for this project.

Goals:
- Explain what each major file/module does (PHP endpoints, JS modules, pages).
- Explain data model: sessions/messages/images, exercises, logs, muscle state, etc (only if present in code).
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

/* Build a single big FILES blob */
$allText = "";
foreach ($docs as $d) {
  $rel = $d["rel"];
  $content = $d["content"];
  $allText .= "===== FILE: {$rel} =====\n" . $content . "\n\n";
}

$userPrompt = <<<PROMPT
{$projectContext}

Analyze ONLY these files and generate MANUAL.md.

Requirements for MANUAL.md:
- Title + short overview
- High-level architecture diagram (ASCII is fine)
- Sections:
  1) Directory/Module Map
  2) Data Model (tables + key fields) (only what appears in files)
  3) API Endpoints (path, method, request JSON, response JSON, errors)
  4) Frontend Flow (pages, JS modules, how calls happen)
  5) AI Intake / MMJ schema explanation (if present)
  6) How to Extend (new exercise, new endpoint, new muscle group)
  7) Troubleshooting (common errors, logs, permissions, DB)
- Be explicit: include filenames and function names where possible.
- If uncertain, label it clearly.

FILES:
{$allText}
PROMPT;

$manualMd = xaiChat($XAI_KEY, $model, [
  ["role" => "system", "content" => "You are a senior engineer writing internal docs. Produce a complete markdown manual. No extra commentary."],
  ["role" => "user", "content" => $userPrompt],
], 0.2, 2500, 120, 20, $DEBUG);

$manualMd = trim($manualMd) . "\n";

/* =========================
   Write output and print
========================= */
$absOut = $outFile;
if (!isAbsPath($absOut)) $absOut = $ROOT . "/" . $outFile;

if (@file_put_contents($absOut, $manualMd) === false) {
  fwrite(STDERR, "ERROR: failed to write {$absOut}\n");
}

echo $manualMd;

/* =========================
   Helpers
========================= */

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
  foreach ($excludeFiles as $xf) {
    if ($base === $xf) return true;
  }

  foreach ($excludeDirs as $xd) {
    $xd = trim(str_replace("\\", "/", $xd), "/");
    if ($xd === "") continue;
    if ($relTrim === $xd) return true;
    if (strpos($relTrim . "/", $xd . "/") === 0) return true;
  }

  return false;
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
  // FOLLOW_SYMLINKS can explode or hit perms weirdly; keep it off unless you need it

  $dirIt = new SafeRecursiveDirectoryIterator($root, $itFlags);

  $filter = new RecursiveCallbackFilterIterator(
    $dirIt,
    function ($current, $key, $iterator) use ($root, $excludeDirs, $excludeFiles, $allowedExt) {
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

    if ($estimatedBytes + $size > $maxTotalBytes * 2) {
      continue;
    }

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

function looksLikeSecret(string $rel, string $content): bool {
  $r = strtolower($rel);
  if (strpos($r, ".env") !== false) return true;
  if (preg_match('/-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----/', $content)) return true;
  if (preg_match('/\b(XAI_API_KEY|OPENAI_API_KEY|API_KEY|SECRET_KEY|PASSWORD)\b/i', $content) && preg_match('/[A-Za-z0-9_\-]{20,}/', $content)) {
    return true;
  }
  return false;
}

function xaiChat(
  string $apiKey,
  string $model,
  array $messages,
  float $temperature = 0.2,
  int $maxTokens = 1800,
  int $timeoutSec = 90,
  int $connectTimeoutSec = 15,
  bool $debug = false
): string {
  $payload = [
    "model" => $model,
    "messages" => $messages,
    "temperature" => $temperature,
    "max_tokens" => $maxTokens,
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

  $content = $res["choices"][0]["message"]["content"] ?? null;
  if (!is_string($content) || trim($content) === "") throw new RuntimeException("xai_missing_content");

  return $content;
}
