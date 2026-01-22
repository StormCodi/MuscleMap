<?php
// api/ai_intake_resolve.php
declare(strict_types=1);
require __DIR__ . "/db.php";
header("Content-Type: application/json; charset=utf-8");

function fail(int $code, string $err): void {
  http_response_code($code);
  echo json_encode(["ok"=>false,"error"=>$err], JSON_UNESCAPED_SLASHES);
  exit;
}

$body = json_decode(file_get_contents("php://input"), true) ?: [];
$sessionId = (int)($body["session_id"] ?? 0);
if ($sessionId <= 0) fail(400, "bad_session_id");

$stmt = $pdo->prepare("SELECT last_mmj_json FROM ai_intake_sessions WHERE id=? AND user_id=?");
$stmt->execute([$sessionId, GLOBAL_USER_ID]);
$row = $stmt->fetch();
if (!$row) fail(404, "session_not_found");

$mmj = json_decode((string)$row["last_mmj_json"], true);
if (!is_array($mmj)) fail(400, "no_mmj");

$action = (string)($mmj["action"] ?? "");

if ($action === "MATCH_EXISTING") {
  $m = $mmj["match"] ?? null;
  if (!is_array($m)) fail(400, "no_match");

  $eid = (string)($m["existing_id"] ?? "");
  if ($eid === "") fail(400, "bad_existing_id");

  // verify it exists + active
  $stmt = $pdo->prepare("
    SELECT exercise_key AS id, name
    FROM exercises
    WHERE user_id=? AND exercise_key=? AND is_active=1
    LIMIT 1
  ");
  $stmt->execute([GLOBAL_USER_ID, $eid]);
  $ex = $stmt->fetch();
  if (!$ex) fail(400, "existing_not_found");

  // mark session done
  $stmt = $pdo->prepare("UPDATE ai_intake_sessions SET status='done' WHERE id=? AND user_id=?");
  $stmt->execute([$sessionId, GLOBAL_USER_ID]);

  echo json_encode(["ok"=>true, "mode"=>"match", "exercise"=>["id"=>$ex["id"], "name"=>$ex["name"]]], JSON_UNESCAPED_SLASHES);
  exit;
}

if ($action === "PROPOSE_NEW") {
  $p = $mmj["proposal"] ?? null;
  if (!is_array($p)) fail(400, "no_proposal");

  $key = (string)($p["exercise_key"] ?? "");
  $name = (string)($p["name"] ?? "");
  $weights = $p["weights"] ?? null;

  if (!preg_match('/^[a-z0-9_]{3,64}$/', $key)) fail(400, "bad_exercise_key");
  if ($name === "") fail(400, "bad_name");
  if (!is_array($weights)) fail(400, "bad_weights");

  // validate weights 0..1
  foreach ($weights as $gid => $w) {
    if (!is_string($gid)) fail(400, "bad_weight_key");
    if (!is_numeric($w)) fail(400, "bad_weight_value");
    $wf = (float)$w;
    if ($wf < 0.0 || $wf > 1.0) fail(400, "weight_out_of_range");
  }

  $weightsJson = json_encode($weights, JSON_UNESCAPED_SLASHES);

  // upsert
  $stmt = $pdo->prepare("
    INSERT INTO exercises (user_id, exercise_key, name, weights_json, source, is_active)
    VALUES (?, ?, ?, CAST(? AS JSON), 'ai', 1)
    ON DUPLICATE KEY UPDATE
      name=VALUES(name),
      weights_json=VALUES(weights_json),
      source='ai',
      is_active=1,
      updated_at=CURRENT_TIMESTAMP
  ");
  $stmt->execute([GLOBAL_USER_ID, $key, $name, $weightsJson]);

  $stmt = $pdo->prepare("UPDATE ai_intake_sessions SET status='done' WHERE id=? AND user_id=?");
  $stmt->execute([$sessionId, GLOBAL_USER_ID]);

  echo json_encode(["ok"=>true, "mode"=>"new", "exercise"=>["id"=>$key, "name"=>$name]], JSON_UNESCAPED_SLASHES);
  exit;
}

fail(400, "nothing_to_resolve");
