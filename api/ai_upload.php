<?php
// api/ai_upload.php
declare(strict_types=1);

require __DIR__ . "/db.php";
header("Content-Type: application/json; charset=utf-8");

// Enforce login (account-based)
$uid = require_user_id();

function bad(string $msg, int $code = 400, array $extra = []): void {
  http_response_code($code);
  echo json_encode(["ok" => false, "error" => $msg] + $extra, JSON_UNESCAPED_SLASHES);
  exit;
}

if ($_SERVER["REQUEST_METHOD"] !== "POST") bad("method_not_allowed", 405);

if (!isset($_FILES["image"])) bad("missing_image");
$f = $_FILES["image"];

if (!is_array($f) || !isset($f["tmp_name"])) bad("bad_upload_shape");

if (($f["error"] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
  bad("upload_error", 400, ["code" => (int)($f["error"] ?? -1)]);
}

$tmp = (string)$f["tmp_name"];
if (!is_file($tmp)) bad("missing_tmp");

$maxBytes = 4_500_000; // ~4.5MB
$size = @filesize($tmp);
if ($size === false || $size <= 0) bad("bad_size");
if ($size > $maxBytes) bad("too_large", 413, ["max" => $maxBytes]);

$finfo = new finfo(FILEINFO_MIME_TYPE);
$mime = (string)($finfo->file($tmp) ?: "");
$allowed = [
  "image/jpeg" => "jpg",
  "image/png"  => "png",
  "image/webp" => "webp",
];
if (!isset($allowed[$mime])) bad("bad_image_type", 415, ["mime" => $mime]);

$token = bin2hex(random_bytes(16));
$ext = $allowed[$mime];

// project root (/var/www/html/musclemap)
$baseDir = realpath(__DIR__ . "/..");
if ($baseDir === false) bad("base_dir_fail", 500);

// PER-USER folder: /uploads/ai_tmp/u{uid}
$dir = $baseDir . "/uploads/ai_tmp/u" . (int)$uid;
if (!is_dir($dir)) {
  if (!@mkdir($dir, 0775, true)) bad("mkdir_fail", 500);
}

// best-effort cleanup: delete files older than 24h (per user folder)
$ttl = 24 * 3600;
foreach (glob($dir . "/*.*") ?: [] as $p) {
  $mt = @filemtime($p);
  if ($mt !== false && $mt < time() - $ttl) @unlink($p);
}

$dst = $dir . "/" . $token . "." . $ext;

if (!@move_uploaded_file($tmp, $dst)) {
  // fallback if move_uploaded_file fails (some configs)
  $bytes = @file_get_contents($tmp);
  if ($bytes === false) bad("move_fail", 500);
  if (@file_put_contents($dst, $bytes) === false) bad("write_fail", 500);
}

@chmod($dst, 0644);

// Return a relative URL the frontend can display
$url = "./uploads/ai_tmp/u" . (int)$uid . "/" . $token . "." . $ext;

echo json_encode([
  "ok" => true,
  "token" => $token,
  "mime" => $mime,
  "url" => $url,
], JSON_UNESCAPED_SLASHES);
