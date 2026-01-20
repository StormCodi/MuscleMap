// Recovery + heat algorithm.
// We track “load” per muscle group and decay it over time.
// recovery.js

function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function hours(ms){ return ms / (1000*60*60); }

export function ensureMuscle(state, id){
  if (!state.muscle[id]){
    state.muscle[id] = {
      load: 0,                // 0..1, increases with training, decays with time
      lastTrained: 0,         // ms
      lastPing: 0,            // ms
    };
  }
  return state.muscle[id];
}

// Decay load over time since lastUpdate
export function tickDecay(state, now=Date.now()){
  const dt = now - (state.lastUpdate || now);
  state.lastUpdate = now;

  // half-life ~ 36 hours (tweak)
  const halfLifeHrs = 36;
  const decay = Math.pow(0.5, hours(dt) / halfLifeHrs);

  for (const id of Object.keys(state.muscle)){
    const m = state.muscle[id];
    m.load = clamp01(m.load * decay);
  }
}

// Apply a workout stimulus to a muscle group.
// stimulus is 0..1-ish
export function applyStimulus(state, id, stimulus, now=Date.now()){
  const m = ensureMuscle(state, id);
  m.load = clamp01(m.load + stimulus);
  m.lastTrained = now;
}

// Convert load + recency into a display “heat” (0..1) and a “risk” signal.
export function computeHeat(state, id, now=Date.now()){
  const m = ensureMuscle(state, id);

  const since = m.lastTrained ? (now - m.lastTrained) : Infinity;
  const sinceH = hours(since);

  // Recent training gets an immediate green bump even at low load
  const freshness = sinceH < 18 ? (1 - sinceH/18) : 0; // 1..0

  // heat is mostly load, with a small freshness bump
  const heat = clamp01(m.load + 0.25 * freshness);

  // overtraining signal: high load + too-recent repeat
  const overdo = (m.load > 0.80 && sinceH < 24) || (m.load > 0.92);

  return { heat, overdo, lastTrained: m.lastTrained, load: m.load };
}

// Neglect detection (for “hey champ hit lats”)
export function isNeglected(state, id, now=Date.now()){
  const m = ensureMuscle(state, id);

  // if never trained, it’s neglected but don’t spam
  if (!m.lastTrained) return true;

  // > 8 days since last trained -> neglected
  const days = (now - m.lastTrained) / (1000*60*60*24);
  return days >= 8;
}
