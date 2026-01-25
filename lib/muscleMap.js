// Map GLB mesh names -> fitness groups.
// Z-Anatomy naming varies, so we use substring tokens.
// muscleMap.js

function hasAny(s, arr){ return arr.some(t => s.includes(t)); }

export const GROUPS = [
  // core regions (simulation)
  { id:"abs_upper", label:"Abs (upper)", tokens:["rectus_abdominis"] , kind:"region" },
  { id:"abs_lower", label:"Abs (lower)", tokens:["rectus_abdominis"] , kind:"region" },
  { id:"obliques_external", label:"Obliques (external)", tokens:["external_abdominal_oblique"] },
  { id:"obliques_internal", label:"Obliques (internal)", tokens:["internal_abdominal_oblique"] },
  { id:"core_deep", label:"Deep core (TVA)", tokens:["transversus_abdominis"] },

  // big groups
  { id:"chest", label:"Chest", tokens:["pectoralis_major","pectoralis_minor"] },
  { id:"lats", label:"Lats", tokens:["latissimus_dorsi"] },
  { id:"upper_back", label:"Upper back", tokens:["trapezius","rhomboid","teres_major","teres_minor","infraspinatus","supraspinatus"] },
  { id:"mid_back", label:"Mid back", tokens:["serratus_posterior","erector_spinae"] },
  { id:"lower_back", label:"Lower back", tokens:["multifidus_thoracis","multifidus_lumborum","quadratus_lumborum"] },

  { id:"shoulders", label:"Shoulders", tokens:["deltoid"] },
  { id:"front_delts", label:"Front delts", tokens:["deltoid"] },
  { id:"side_delts", label:"Side delts", tokens:["deltoid"] },
  { id:"rear_delts", label:"Rear delts", tokens:["deltoid"] },

  { id:"biceps", label:"Biceps", tokens:["biceps_brachii","brachialis"] },
  { id:"triceps", label:"Triceps", tokens:["triceps_brachii"] },
  { id:"forearms", label:"Forearms", tokens:["brachioradialis","flexor_carpi","extensor_carpi"] },

  { id:"quads", label:"Quads", tokens:["rectus_femoris","vastus_lateralis","vastus_medialis","vastus_intermedius"] },
  { id:"hamstrings", label:"Hamstrings", tokens:["biceps_femoris","semitendinosus","semimembranosus"] },
  { id:"glutes", label:"Glutes", tokens:["gluteus_maximus","gluteus_medius","gluteus_minimus"] },
  { id:"calves", label:"Calves", tokens:["gastrocnemius","soleus"] },

  { id:"upper_traps", label:"Upper traps", tokens:["trapezius"] },
  { id:"posterior_chain", label:"Posterior chain", tokens:["erector_spinae","gluteus","hamstring"] },

  { id:"core", label:"Core", tokens:["rectus_abdominis","external_abdominal_oblique","internal_abdominal_oblique","transversus_abdominis"] },
];

// things we never want clickable / visible as “gym muscles”
const MICRO_REJECT = [
  // face / neck / tiny
  "orbicularis","nasalis","frontalis","buccinator","masseter","temporalis",
  "platysma","digastric","mylohyoid","geniohyoid","sternohyoid","omohyoid",
  "thyrohyoid","crico","aryten","laryn","pharyn","tongue","hyoid",
  // hands/feet micro
  "interosse","lumbrical","thenar","hypothenar","palmaris_brevis",
  "abductor_digiti","opponens","flexor_pollicis","extensor_pollicis",
  "retinaculum","tarsal","plantar",
];

// shell identifiers
const SHELL_TOKENS = ["superficial","skin","fascia","fasciar"];

// A mesh is “gym-relevant” if:
// - name contains _muscle / _muscler
// - not micro reject
// - matches at least one group token OR is a big/common muscle token
const BIG_MUSCLE_FALLBACK = [
  "pectoralis","deltoid","biceps","triceps",
  "latissimus","trapezius","rhomboid",
  "rectus_abdominis","oblique","gluteus",
  "vastus","rectus_femoris",
  "gastrocnemius","soleus",
  "biceps_femoris","semitendinosus","semimembranosus",
  "erector_spinae","quadratus_lumborum",
];

export function classifyMeshName(name){
  const n = (name || "").toLowerCase();

  // TEMP: hide this specific mesh entirely
 // Permanently hide obliques (visual noise; rectus is the trained muscle)
if (
  n.includes("external_abdominal_oblique") ||
  n.includes("internal_abdominal_oblique")
) {
  return { kind: "ignore" };
}


  const isShell = hasAny(n, SHELL_TOKENS) && !n.includes("_muscle") && !n.includes("_muscler");
  const isMuscle = n.includes("_muscle") || n.includes("_muscler");

  if (isShell) return { kind:"shell" };

  if (!isMuscle) return { kind:"ignore" };

  if (hasAny(n, MICRO_REJECT)) return { kind:"ignore" };

  // match groups
  const matched = [];
  for (const g of GROUPS){
    if (hasAny(n, g.tokens)) matched.push(g.id);
  }

  if (matched.length) return { kind:"gym", groups: matched };

  // fallback for big muscles if names differ slightly
  if (hasAny(n, BIG_MUSCLE_FALLBACK)) return { kind:"gym", groups: ["core"] };

  return { kind:"ignore" };
}
