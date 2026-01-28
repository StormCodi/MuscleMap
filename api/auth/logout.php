<?php
declare(strict_types=1);

header("Content-Type: application/json; charset=utf-8");

function ok(array $extra = []): void {
  echo json_encode(["ok" => true] + $extra, JSON_UNESCAPED_SLASHES);
  exit;
}

function boot_session(): void {
  if (session_status() === PHP_SESSION_ACTIVE) return;

  $isHttps = (!empty($_SERVER["HTTPS"]) && $_SERVER["HTTPS"] !== "off")
          || (isset($_SERVER["SERVER_PORT"]) && (int)$_SERVER["SERVER_PORT"] === 443);

  session_set_cookie_params([
    "lifetime" => 0,
    "path" => "/",
    "domain" => "",
    "secure" => $isHttps,
    "httponly" => true,
    "samesite" => "Lax",
  ]);

  session_start();
}

boot_session();

// Clear session data
$_SESSION = [];

// Delete session cookie
if (ini_get("session.use_cookies")) {
  $p = session_get_cookie_params();
  setcookie(session_name(), "", time() - 42000, [
    "path" => $p["path"] ?? "/",
    "domain" => $p["domain"] ?? "",
    "secure" => (bool)($p["secure"] ?? false),
    "httponly" => (bool)($p["httponly"] ?? true),
    "samesite" => $p["samesite"] ?? "Lax",
  ]);
}

// Destroy server session
@session_destroy();

ok();
