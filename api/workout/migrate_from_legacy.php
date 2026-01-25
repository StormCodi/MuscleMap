<?php
// api/workout/migrate_from_legacy.php
declare(strict_types=1);

require __DIR__ . "/_lib.php";

/*
CLI usage:
  sudo php api/workout/migrate_from_legacy.php --uid=0
  sudo php api/workout/migrate_from_legacy.php --uid=0 --dry=1
  sudo php api/workout/migrate_from_legacy.php --uid=0 --truncate=1

Notes:
- Does NOT create tables (your DB user lacks CREATE).
- Does NOT depend on web session. Works in CLI.
- Migrates legacy workout_logs -> workouts + workout_sets.
- Groups by workout_date (one workout per day).
- Splits legacy stimulus across sets to preserve totals.
- If workout_logs.muscles_json is NULL, tries to fill from exercises (w or muscles_json).
*/



function is_cli(): bool {
  return PHP_SAPI === "cli";
}

function parse_cli_args(array $argv): array {
  $out = [];
  foreach ($argv as $i => $a) {
    if ($i === 0) continue;
    if (strpos($a, "--") !== 0) continue;
    $a = substr($a, 2);
    $eq = strpos($a, "=");
    if ($eq === false) {
      $out[$a] = "1";
    } else {
      $k = substr($a, 0, $eq);
      $v = substr($a, $eq + 1);
      $out[$k] = $v;
    }
  }
  return $out;
}

function parseSqlDateTime(?string $s): ?string {
  if (!$s) return null;
  $s = trim($s);
  // accept "YYYY-MM-DD HH:MM:SS"
  if (preg_match('/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/', $s)) return $s;
  // accept date only
  if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $s)) return $s . " 12:00:00";
  return null;
}

function normalize_muscles_json($mj, ?array $fallback): ?string {
  // Return JSON string or null
  if ($mj !== null && $mj !== "") {
    if (is_string($mj)) return $mj;
    $enc = json_encode($mj, JSON_UNESCAPED_SLASHES);
    return $enc === false ? null : $enc;
  }
  if ($fallback && count($fallback)) {
    $enc = json_encode($fallback, JSON_UNESCAPED_SLASHES);
    return $enc === false ? null : $enc;
  }
  return null;
}

function load_exercise_weights(PDO $pdo): array {
  // Try to read either exercises.w (json) or exercises.muscles_json (json).
  // Because your exercises table is inconsistent, we’ll inspect columns first.
  $cols = [];
  foreach (($pdo->query("SHOW COLUMNS FROM exercises")->fetchAll(PDO::FETCH_ASSOC) ?: []) as $c) {
    $cols[strtolower((string)$c["Field"])] = true;
  }

  $hasW = isset($cols["w"]);
  $hasMJ = isset($cols["muscles_json"]);
  if (!$hasW && !$hasMJ) return [];

  $selectCol = $hasW ? "w" : "muscles_json";

  $rows = $pdo->query("SELECT id, {$selectCol} AS weights FROM exercises")->fetchAll(PDO::FETCH_ASSOC) ?: [];
  $map = [];

  foreach ($rows as $r) {
    $id = (string)$r["id"];
    $weights = $r["weights"];

    if ($weights === null || $weights === "") continue;

    if (is_string($weights)) {
      $decoded = json_decode($weights, true);
      if (is_array($decoded)) $map[$id] = $decoded;
      continue;
    }

    // some drivers may already decode JSON into array/object
    if (is_array($weights)) {
      $map[$id] = $weights;
      continue;
    }
  }

  return $map;
}

/* -------------------- start -------------------- */

$args = is_cli() ? parse_cli_args($argv) : $_GET;

$uid = isset($args["uid"]) ? (int)$args["uid"] : 0;
$dry = isset($args["dry"]) && (string)$args["dry"] === "1";
$truncate = isset($args["truncate"]) && (string)$args["truncate"] === "1";

try {
  // verify tables exist (no CREATE)
  $pdo->query("SELECT 1 FROM workouts LIMIT 1");
  $pdo->query("SELECT 1 FROM workout_sets LIMIT 1");
  $pdo->query("SELECT 1 FROM workout_logs LIMIT 1");
} catch (Throwable $e) {
  json_err("Missing required table(s): " . $e->getMessage(), 500);
}

$exerciseWeights = load_exercise_weights($pdo);

// pull legacy logs for uid
$legacy = $pdo->prepare("
  SELECT
    id, user_id, workout_date, exercise_id, exercise_name,
    sets, reps, load_lbs, stimulus, created_at, muscles_json
  FROM workout_logs
  WHERE user_id = ?
  ORDER BY workout_date ASC, id ASC
");
$legacy->execute([$uid]);
$rows = $legacy->fetchAll(PDO::FETCH_ASSOC) ?: [];

if (!$rows) {
  json_ok(["uid" => $uid, "migrated_workouts" => 0, "migrated_sets" => 0, "message" => "No legacy rows for uid"]);
}

// group by workout_date
$byDate = [];
foreach ($rows as $r) {
  $d = (string)$r["workout_date"];
  if ($d === "") $d = "unknown";
  if (!isset($byDate[$d])) $byDate[$d] = [];
  $byDate[$d][] = $r;
}

$mWorkouts = 0;
$mSets = 0;

if ($dry) {
  json_ok([
    "uid" => $uid,
    "dry" => true,
    "legacy_rows" => count($rows),
    "dates" => count($byDate),
    "note" => "Dry run only; no inserts performed."
  ]);
}

// truncate for uid (optional)
if ($truncate) {
  // delete sets joined to workouts for this user (FK cascade should delete sets when deleting workouts,
  // but we’ll do workouts delete only).
  $delW = $pdo->prepare("DELETE FROM workouts WHERE user_id = ?");
  $delW->execute([$uid]);
}

$insW = $pdo->prepare("
  INSERT INTO workouts (user_id, started_at, ended_at, auto_closed, created_at, updated_at)
  VALUES (?, ?, ?, 0, ?, ?)
");

$insS = $pdo->prepare("
  INSERT INTO workout_sets
    (workout_id, user_id, exercise_id, exercise_name, reps, load_lbs, stimulus, muscles_json, created_at, updated_at)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
");

try {
  $pdo->beginTransaction();

  foreach ($byDate as $date => $items) {
    // Use first created_at as start, last as end-ish
    $first = parseSqlDateTime($items[0]["created_at"] ?? null) ?: ($date . " 12:00:00");
    $last  = parseSqlDateTime($items[count($items) - 1]["created_at"] ?? null) ?: ($date . " 13:00:00");

    $startAt = (string)$first;
    $endAt   = (string)$last;

    $insW->execute([$uid, $startAt, $endAt, $startAt, $endAt]);
    $wid = (int)$pdo->lastInsertId();
    if (!$wid) throw new RuntimeException("Failed to insert workout row");

    $mWorkouts++;

    foreach ($items as $r) {
      $setsN = (int)($r["sets"] ?? 1);
      $setsN = max(1, min(50, $setsN));

      $reps = (int)($r["reps"] ?? 1);
      $reps = max(1, min(1000, $reps));

      $load = ($r["load_lbs"] === null ? null : (float)$r["load_lbs"]);

      $stimTotal = (float)($r["stimulus"] ?? 0.0);
      if (!is_finite($stimTotal) || $stimTotal < 0) $stimTotal = 0.0;

      // split stimulus across sets so totals match legacy
      $stimPer = $setsN > 0 ? ($stimTotal / $setsN) : $stimTotal;

      $exId = (string)($r["exercise_id"] ?? "");
      $fallback = $exerciseWeights[$exId] ?? null;

      $mjStr = normalize_muscles_json($r["muscles_json"] ?? null, $fallback);

      $created = parseSqlDateTime((string)($r["created_at"] ?? "")) ?: $startAt;
      $updated = $created;

      for ($i = 0; $i < $setsN; $i++) {
        $insS->execute([
          $wid, $uid,
          $exId,
          (string)($r["exercise_name"] ?? $exId),
          $reps,
          $load,
          $stimPer,
          $mjStr,
          $created,
          $updated
        ]);
        $mSets++;
      }
    }
  }

  $pdo->commit();
} catch (Throwable $e) {
  if ($pdo->inTransaction()) $pdo->rollBack();
  json_err("Migration failed: " . $e->getMessage(), 500);
}

json_ok([
  "uid" => $uid,
  "migrated_workouts" => $mWorkouts,
  "migrated_sets" => $mSets,
  "dates" => count($byDate),
  "truncate" => $truncate ? 1 : 0,
]);
