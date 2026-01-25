//recs.js
import { isNeglected, computeHeat } from "./recovery.js";

export function generateRecs(state, groupIds, now=Date.now()){
  const items = [];
 
  for (const id of groupIds){
    const { heat, overdo } = computeHeat(state, id, now);
    const neglected = isNeglected(state, id, now);

    if (overdo){
      items.push({ type:"warn", id, text:`${id}: chill — recovery needed (you’re stacking volume too fast).` });
      continue;
    }

    if (neglected){
      items.push({ type:"nudge", id, text:`${id}: neglected. Add 2–4 sets this week.` });
      continue;
    }

    if (heat < 0.18){
      items.push({ type:"balance", id, text:`${id}: light. Consider adding a little volume.` });
    }
  }

  // prioritize warnings and neglected
  const score = (it) => it.type === "warn" ? 0 : it.type === "nudge" ? 1 : 2;
  items.sort((a,b)=>score(a)-score(b));

  return items.slice(0, 6);
}
