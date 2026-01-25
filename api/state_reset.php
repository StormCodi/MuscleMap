<?php
// // api/state_reset.php
// header("Content-Type: application/json; charset=utf-8");

// require __DIR__ . "/db.php";

// try {
//   $del = $pdo->prepare("DELETE FROM workout_logs WHERE user_id = ?");
//   $del->execute([GLOBAL_USER_ID]);

//   echo json_encode([
//     "ok" => true,
//     "deleted_logs" => $del->rowCount(),
//   ]);
// } catch (Throwable $e) {
//   http_response_code(500);
//   echo json_encode(["ok" => false, "error" => "EXCEPTION: " . $e->getMessage()]);
// }
