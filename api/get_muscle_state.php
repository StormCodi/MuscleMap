<?php
// api/get_muscle_state.php
header("Content-Type: application/json");

require __DIR__ . "/db.php";

$stmt = $pdo->prepare("
  SELECT muscle_group, load_value, last_trained_at, last_ping_at
  FROM muscle_state
  WHERE user_id = ?
  ORDER BY muscle_group ASC
");
$stmt->execute([GLOBAL_USER_ID]);

echo json_encode([
  "ok" => true,
  "rows" => $stmt->fetchAll(),
]);
