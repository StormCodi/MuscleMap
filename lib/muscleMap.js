// lib/muscleMap.js
// Map GLB mesh names -> fitness groups.
// Z-Anatomy naming varies a LOT, so we normalize names and match using tokens.
// "gym" is OUR label: means "clickable + heat-painted muscle mesh".

/* ==============================
   Name normalization helpers
============================== */

// Lowercase, replace separators, remove junk, keep as one searchable string.
// Also split CamelCase-ish names into spaces (good for "TricepsBrachiiLongHead").
function normalizeName(name) {
  let s = String(name || "");

  // insert spaces before Capitals: "TricepsBrachii" -> "Triceps Brachii"
  s = s.replace(/([a-z])([A-Z])/g, "$1 $2");

  s = s.toLowerCase();

  // common separators -> spaces
  s = s.replace(/[_\-./\\]+/g, " ");

  // collapse multiple spaces
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

function hasAnyToken(normalizedName, tokens) {
  const s = normalizedName;
  return (tokens || []).some((t) => s.includes(String(t).toLowerCase()));
}

/* ==============================
   Group definitions
============================== */

export const GROUPS = [
  // core regions (simulation)
  { id: "abs_upper", label: "Abs (upper)", tokens: ["rectus abdominis"], kind: "region" },
  { id: "abs_lower", label: "Abs (lower)", tokens: ["rectus abdominis"], kind: "region" },

  // obliques (OPTIONAL: some people hate the visual noise)
  { id: "obliques_external", label: "Obliques (external)", tokens: ["external abdominal oblique"] },
  { id: "obliques_internal", label: "Obliques (internal)", tokens: ["internal abdominal oblique"] },

  { id: "core_deep", label: "Deep core (TVA)", tokens: ["transversus abdominis"], kind: "region" },

  // big groups
  { id: "chest", label: "Chest", tokens: ["pectoralis major", "pectoralis minor"] },
  { id: "lats", label: "Lats", tokens: ["latissimus dorsi"] },

  // back
  { id: "upper_back", label: "Upper back", tokens: ["trapezius", "rhomboid", "teres major", "teres minor", "infraspinatus", "supraspinatus"] },
  { id: "mid_back", label: "Mid back", tokens: ["serratus posterior", "erector spinae"] },
  { id: "lower_back", label: "Lower back", tokens: ["multifidus thoracis", "multifidus lumborum", "quadratus lumborum"] },

  // shoulders (NOTE: deltoid will match multiple subgroup ids unless you choose to collapse it)
  { id: "shoulders", label: "Shoulders", tokens: ["deltoid"] },
  { id: "front_delts", label: "Front delts", tokens: ["deltoid"] },
  { id: "side_delts", label: "Side delts", tokens: ["deltoid"] },
  { id: "rear_delts", label: "Rear delts", tokens: ["deltoid"] },

  // arms
  { id: "biceps", label: "Biceps", tokens: ["biceps brachii", "brachialis"] },

  // IMPORTANT: Z-Anatomy often uses "triceps brachii" WITHOUT underscore and sometimes camelcase.
  // Normalization makes this match both:
  // - "triceps_brachii_muscle"
  // - "TricepsBrachiiLongHead"
  { id: "triceps", label: "Triceps", tokens: ["triceps brachii", "triceps"] },

  { id: "forearms", label: "Forearms", tokens: ["brachioradialis", "flexor carpi", "extensor carpi"] },

  // legs
  { id: "quads", label: "Quads", tokens: ["rectus femoris", "vastus lateralis", "vastus medialis", "vastus intermedius", "vastus"] },
  { id: "hamstrings", label: "Hamstrings", tokens: ["biceps femoris", "semitendinosus", "semimembranosus", "hamstring"] },
  { id: "glutes", label: "Glutes", tokens: ["gluteus maximus", "gluteus medius", "gluteus minimus", "gluteus"] },
  { id: "calves", label: "Calves", tokens: ["gastrocnemius", "soleus"] },

  // misc
  { id: "upper_traps", label: "Upper traps", tokens: ["trapezius"] },
  { id: "posterior_chain", label: "Posterior chain", tokens: ["erector spinae", "gluteus", "hamstring"] },

  // aggregated core
  { id: "core", label: "Core", tokens: ["rectus abdominis", "external abdominal oblique", "internal abdominal oblique", "transversus abdominis"] },
];

/* ==============================
   Visibility rules
============================== */

// Things we never want clickable / visible as “gym muscles”
const MICRO_REJECT = [
  // face / neck / tiny
  "orbicularis", "nasalis", "frontalis", "buccinator", "masseter", "temporalis",
  "platysma", "digastric", "mylohyoid", "geniohyoid", "sternohyoid", "omohyoid",
  "thyrohyoid", "crico", "aryten", "laryn", "pharyn", "tongue", "hyoid",

  // hands/feet micro
  "interosse", "lumbrical", "thenar", "hypothenar", "palmaris brevis",
  "abductor digiti", "opponens", "flexor pollicis", "extensor pollicis",
  "retinaculum", "tarsal", "plantar",
];

// Shell-ish identifiers (skin / fascia)
const SHELL_TOKENS = ["superficial", "skin", "fascia", "fasciar"];

// Big muscle fallback tokens if names don’t match group tokens cleanly
// NOTE: This is intentionally broad; it’s only used after rejects + muscle gating.
const BIG_MUSCLE_FALLBACK = [
  "pectoralis", "deltoid", "biceps", "triceps",
  "latissimus", "trapezius", "rhomboid",
  "rectus abdominis", "oblique", "gluteus",
  "vastus", "rectus femoris",
  "gastrocnemius", "soleus",
  "biceps femoris", "semitendinosus", "semimembranosus",
  "erector spinae", "quadratus lumborum",
];

/* ==============================
   Obliques hide switch
   (You had this hard-coded. Make it explicit.)
============================== */

// If true: oblique meshes are hidden completely (visual noise reduction).
// If false: obliques show and can be heat-painted like any other muscle.
const HIDE_OBLIQUES = true;

/* ==============================
   Classifier
============================== */

export function classifyMeshName(name) {
  const n = normalizeName(name);

  // Optional: hide obliques entirely
  if (
    HIDE_OBLIQUES &&
    (n.includes("external abdominal oblique") || n.includes("internal abdominal oblique"))
  ) {
    return { kind: "ignore" };
  }

  // shell check:
  // Z-Anatomy sometimes uses "skin" or "superficial fascia" meshes that are NOT muscles.
  // If it looks like shell and does NOT look like a muscle, treat as shell.
  const looksShell = hasAnyToken(n, SHELL_TOKENS);
  const looksMuscle = n.includes("muscle") || n.includes("muscler") || n.includes("myo") || n.includes("biceps") || n.includes("triceps");

  if (looksShell && !looksMuscle) return { kind: "shell" };

  // Hard reject micro anatomy
  if (hasAnyToken(n, MICRO_REJECT)) return { kind: "ignore" };

  // Gate: if it does NOT look like a muscle at all, ignore it.
  // (This avoids bones, organs, vessels, etc.)
  if (!looksMuscle) return { kind: "ignore" };

  // Match group tokens
  const matched = [];
  for (const g of GROUPS) {
    if (hasAnyToken(n, g.tokens)) matched.push(g.id);
  }

  if (matched.length) {
    return { kind: "gym", groups: matched };
  }

  // Broad fallback: if it’s clearly a big muscle but didn’t match tokens,
  // keep it clickable (otherwise you get “missing muscles” like your triceps issue).
  if (hasAnyToken(n, BIG_MUSCLE_FALLBACK)) {
    // Better than "core" random default:
    // If we can detect triceps/biceps/deltoid quickly, map them.
    if (n.includes("triceps")) return { kind: "gym", groups: ["triceps"] };
    if (n.includes("biceps")) return { kind: "gym", groups: ["biceps"] };
    if (n.includes("deltoid")) return { kind: "gym", groups: ["shoulders"] };
    if (n.includes("pectoralis")) return { kind: "gym", groups: ["chest"] };
    if (n.includes("latissimus")) return { kind: "gym", groups: ["lats"] };

    // last resort: keep as gym but don’t pretend it’s "core"
    // (unknown group means it won't get stimulus weights unless you add them)
    return { kind: "gym", groups: [] };
  }

  return { kind: "ignore" };
}
