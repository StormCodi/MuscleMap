<?php
// api/log_workout.php

header("Content-Type: application/json; charset=utf-8");

// TEMP: show fatal errors as JSON (turn off after it's fixed)
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

$raw = file_get_contents("php://input");
$data = json_decode($raw, true);

if (!is_array($data)) {
  http_response_code(400);
  echo json_encode(["ok" => false, "error" => "Invalid JSON"]);
  exit;
}

$required = ["date","exercise_id","exercise_name","sets","reps","stimulus","muscles"];
foreach ($required as $k) {
  if (!array_key_exists($k, $data)) {
    http_response_code(400);
    echo json_encode(["ok" => false, "error" => "Missing $k"]);
    exit;
  }
}

$date          = (string)$data["date"];
$exercise_id   = (string)$data["exercise_id"];
$exercise_name = (string)$data["exercise_name"];
$sets          = (int)$data["sets"];
$reps          = (int)$data["reps"];
$stimulus      = (float)$data["stimulus"];
$load_lbs      = array_key_exists("load_lbs", $data) && $data["load_lbs"] !== null ? (float)$data["load_lbs"] : null;

$muscles = $data["muscles"];
if (!is_array($muscles)) {
  http_response_code(400);
  echo json_encode(["ok" => false, "error" => "muscles must be an object map"]);
  exit;
}

// Store snapshot on the log row so future exercise weight edits don't rewrite history
$muscles_json = json_encode($muscles, JSON_UNESCAPED_SLASHES);
if ($muscles_json === false) $muscles_json = null;

$now = date("Y-m-d H:i:s");

// Insert workout log (single source of truth)
$ins = $pdo->prepare("
  INSERT INTO workout_logs
    (user_id, workout_date, exercise_id, exercise_name, sets, reps, load_lbs, stimulus, created_at, muscles_json)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
");
$ins->execute([
  GLOBAL_USER_ID,
  $date,
  $exercise_id,
  $exercise_name,
  $sets,
  $reps,
  $load_lbs,
  $stimulus,
  $now,
  $muscles_json
]);

echo json_encode(["ok" => true]);
