// lib/exercises.js
const API_LIST = "./api/exercises_list.php";

let _cache = null;
let _cacheAt = 0;
const TTL = 60_000;

async function fetchList(){
  const res = await fetch(API_LIST, { credentials:"same-origin", cache:"no-store" });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data?.exercises) ? data.exercises : [];
}

export async function getAllExercisesCached(){
  const now = Date.now();
  if (_cache && (now - _cacheAt) < TTL) return _cache;
  _cache = await fetchList();
  _cacheAt = now;
  return _cache;
}

export async function getExerciseById(id){
  const list = await getAllExercisesCached();
  return list.find(e => e.id === id) || null;
}

export function bustExercisesCache(){
  _cache = null;
  _cacheAt = 0;
}
