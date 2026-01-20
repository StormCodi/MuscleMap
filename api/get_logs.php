<?php
// api/get_logs.php
header("Content-Type: application/json");

require __DIR__ . "/db.php";

$stmt = $pdo->prepare("
  SELECT id, workout_date, exercise_id, exercise_name, sets, reps, load_lbs, stimulus
  FROM workout_logs
  WHERE user_id = ?
  ORDER BY workout_date DESC, id DESC
  LIMIT 250
");
$stmt->execute([GLOBAL_USER_ID]);

echo json_encode([
  "ok" => true,
  "rows" => $stmt->fetchAll(),
]); 
