// storage.js

const KEY = "musclemap.v1";

export function loadState(){
  try{
    const raw = localStorage.getItem(KEY);
    if (!raw) return makeDefaultState();
    const s = JSON.parse(raw);
    return normalizeState(s);
  }catch{
    return makeDefaultState();
  }
}

export function saveState(state){
  localStorage.setItem(KEY, JSON.stringify(state));
}

export function resetState(){
  localStorage.removeItem(KEY);
}

function makeDefaultState(){
  return normalizeState({
    logs: [],
    muscle: {},        // per group id
    lastUpdate: Date.now()
  });
}

function normalizeState(s){
  if (!s || typeof s !== "object") s = {};
  if (!Array.isArray(s.logs)) s.logs = [];
  if (!s.muscle || typeof s.muscle !== "object") s.muscle = {};
  if (!Number.isFinite(s.lastUpdate)) s.lastUpdate = Date.now();
  return s;
}
