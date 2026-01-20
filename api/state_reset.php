<?php
header("Content-Type: application/json; charset=utf-8");

ini_set("display_errors", "1");
ini_set("display_startup_errors", "1");
error_reporting(E_ALL);

set_exception_handler(function($e){
  http_response_code(500);
  echo json_encode(["ok"=>false,"error"=>"EXCEPTION: ".$e->getMessage()]);
  exit;
});
set_error_handler(function($severity,$message,$file,$line){
  http_response_code(500);
  echo json_encode(["ok"=>false,"error"=>"PHP ERROR: $message ($file:$line)"]);
  exit;
});
register_shutdown_function(function(){
  $e = error_get_last();
  if ($e && in_array($e["type"], [E_ERROR,E_PARSE,E_CORE_ERROR,E_COMPILE_ERROR], true)) {
    http_response_code(500);
    echo json_encode(["ok"=>false,"error"=>"FATAL: {$e["message"]} ({$e["file"]}:{$e["line"]})"]);
  }
});

require __DIR__ . "/db.php";

try {
  $pdo->beginTransaction();

  // delete global/shared data
  $stmt1 = $pdo->prepare("DELETE FROM workout_logs WHERE user_id = ?");
  $stmt1->execute([GLOBAL_USER_ID]);

  $stmt2 = $pdo->prepare("DELETE FROM muscle_state WHERE user_id = ?");
  $stmt2->execute([GLOBAL_USER_ID]);

  $pdo->commit();

  echo json_encode([
    "ok" => true,
    "deleted_logs" => $stmt1->rowCount(),
    "deleted_muscles" => $stmt2->rowCount()
  ]);
} catch (Throwable $e) {
  if ($pdo->inTransaction()) $pdo->rollBack();
  http_response_code(500);
  echo json_encode(["ok"=>false,"error"=>$e->getMessage()]);
}
