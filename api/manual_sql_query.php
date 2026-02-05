<?php
declare(strict_types=1);

require __DIR__ . "/db.php";

$uid = require_user_id();
if ($uid !== 1) json_err("access_denied", 403);

if ($_SERVER["REQUEST_METHOD"] !== "POST") json_err("method_not_allowed", 405);

$raw = file_get_contents("php://input");
$in = json_decode($raw ?: "{}", true);
if (!is_array($in)) $in = [];

$sql = trim((string)($in["sql"] ?? ""));
if ($sql === "") json_err("missing_sql", 400);

// hard rules: SELECT only, no multi-statement
if (!preg_match('/^\s*SELECT\b/is', $sql)) json_err("select_only", 400);
if (strpos($sql, ";") !== false) json_err("no_multi_statement", 400);

// block obvious footguns
$bad = [
  "into outfile", "into dumpfile", "load_file", "benchmark(", "sleep(",
  "information_schema.", "mysql.", "performance_schema.", "sys.",
];
$low = strtolower($sql);
foreach ($bad as $b) {
  if (strpos($low, $b) !== false) json_err("query_blocked", 400, ["hit" => $b]);
}

// enforce some cap if missing LIMIT
if (!preg_match('/\bLIMIT\s+\d+/i', $sql)) {
  $sql .= " LIMIT 50";
} else {
  // clamp LIMIT to <= 200 (rough safety)
  if (preg_match('/\bLIMIT\s+(\d+)/i', $sql, $m)) {
    $n = (int)$m[1];
    if ($n > 200) {
      $sql = preg_replace('/\bLIMIT\s+\d+/i', "LIMIT 200", $sql, 1) ?? $sql;
    }
  }
}

try {
  // Use unbuffered? PDO default is fine here
  $stmt = $pdo->query($sql);
  $rows = $stmt ? $stmt->fetchAll(PDO::FETCH_ASSOC) : [];
  json_ok([
    "sql" => $sql,
    "rows" => $rows,
    "count" => is_array($rows) ? count($rows) : 0,
  ]);
} catch (Throwable $e) {
  json_err("query_failed", 500, ["err" => $e->getMessage()]);
}
