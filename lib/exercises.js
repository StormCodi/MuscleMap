// Exercises -> muscle group weights (0..1)
// This is fitness logic (regions/groups), not “anatomy is separate muscles”.
//exercises.js

export const EXERCISES = [
  // Chest
  { id:"bench_press", name:"Bench press", w:{ chest:0.9, triceps:0.4, front_delts:0.3 } },
  { id:"incline_press", name:"Incline press", w:{ chest:0.7, front_delts:0.5, triceps:0.35 } },
  { id:"pushups", name:"Push-ups", w:{ chest:0.7, triceps:0.35, front_delts:0.25 } },

  // Back
  { id:"pullups", name:"Pull-ups / chin-ups", w:{ lats:0.8, biceps:0.4, upper_back:0.35 } },
  { id:"lat_pulldown", name:"Lat pulldown", w:{ lats:0.75, biceps:0.35, upper_back:0.25 } },
  { id:"barbell_row", name:"Row", w:{ mid_back:0.75, lats:0.4, biceps:0.25 } },

  // Shoulders
  { id:"ohp", name:"Overhead press", w:{ shoulders:0.8, triceps:0.4, upper_traps:0.2 } },
  { id:"lateral_raise", name:"Lateral raise", w:{ side_delts:0.9 } },
  { id:"rear_delt_fly", name:"Rear delt fly", w:{ rear_delts:0.9, upper_back:0.3 } },

  // Arms
  { id:"curl", name:"Biceps curl", w:{ biceps:0.9, forearms:0.25 } },
  { id:"tricep_pushdown", name:"Triceps pushdown", w:{ triceps:0.9 } },

  // Legs
  { id:"squat", name:"Squat", w:{ quads:0.8, glutes:0.55, core:0.25 } },
  { id:"rdl", name:"Romanian deadlift", w:{ hamstrings:0.85, glutes:0.45, lower_back:0.2 } },
  { id:"deadlift", name:"Deadlift", w:{ posterior_chain:0.8, glutes:0.5, hamstrings:0.5, lower_back:0.35, upper_traps:0.25 } },
  { id:"leg_press", name:"Leg press", w:{ quads:0.85, glutes:0.45 } },
  { id:"calf_raise", name:"Calf raise", w:{ calves:0.95 } },

  // Core (simulate upper/lower abs)
  { id:"crunch", name:"Crunch", w:{ abs_upper:0.8, abs_lower:0.2 } },
  { id:"leg_raise", name:"Leg raise", w:{ abs_lower:0.8, abs_upper:0.2 } },
  { id:"plank", name:"Plank", w:{ core_deep:0.6, abs_upper:0.2, abs_lower:0.2 } },
  { id:"side_plank", name:"Side plank", w:{ obliques_external:0.6, obliques_internal:0.4 } },
  { id:"russian_twist", name:"Russian twist", w:{ obliques_external:0.6, obliques_internal:0.4, abs_upper:0.2 } },
];

export function getExerciseById(id){
  return EXERCISES.find(e => e.id === id) || null;
}
