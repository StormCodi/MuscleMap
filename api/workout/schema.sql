-- api/workout/schema.sql

CREATE TABLE IF NOT EXISTS workouts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  started_at DATETIME NOT NULL,
  ended_at DATETIME NULL,
  auto_closed TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_user_active (user_id, ended_at, started_at),
  KEY idx_user_started (user_id, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS workout_sets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  workout_id BIGINT UNSIGNED NOT NULL,
  user_id INT NOT NULL,

  exercise_id VARCHAR(64) NOT NULL,
  exercise_name VARCHAR(255) NOT NULL,

  reps INT NOT NULL,
  load_lbs DECIMAL(10,2) NULL,

  stimulus DECIMAL(10,6) NOT NULL,
  muscles_json JSON NULL,

  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,

  PRIMARY KEY (id),
  KEY idx_workout (workout_id, id),
  KEY idx_user_created (user_id, created_at),
  CONSTRAINT fk_workout_sets_workout
    FOREIGN KEY (workout_id) REFERENCES workouts(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
