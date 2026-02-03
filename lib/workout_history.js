// lib/workout_history.js
import { escapeHtml, fmtWorkoutDate, fmtWorkoutTitle } from "./utils.js";

export function createWorkoutHistory({
  dom,
  apiJson,
  API,
  historyPerPage = 5,

  getActiveWorkout,       // () => activeWorkout|null
  getViewingWorkoutId,    // () => number|null
  onSelectWorkout,        // async (wid:number) => void
}) {
  const {
    historyBox,
    prevPageBtn,
    nextPageBtn,
    pageHint,
  } = dom;

  let historyPage = 1;
  let historyPages = 1;

  function getHistoryPage() { return historyPage; }
  function getHistoryPages() { return historyPages; }

  async function refreshHistory() {
    const data = await apiJson(`${API.WORKOUT_LIST}?page=${historyPage}&per=${historyPerPage}`, { method: "GET" });
    const workouts = Array.isArray(data.workouts) ? data.workouts : [];

    historyPages = Number(data.pages) || 1;
    historyPage = Number(data.page) || 1;

    if (prevPageBtn) prevPageBtn.disabled = historyPage <= 1;
    if (nextPageBtn) nextPageBtn.disabled = historyPage >= historyPages;
    if (pageHint) pageHint.textContent = historyPages > 1 ? `Page ${historyPage} / ${historyPages}` : "";

    if (!historyBox) return;

    const activeWorkout = getActiveWorkout?.();
    const viewingWorkoutId = getViewingWorkoutId?.();

    historyBox.innerHTML = workouts.map((w) => {
      const isLive = activeWorkout && Number(activeWorkout.id) === Number(w.id);
      const isViewing = viewingWorkoutId && Number(viewingWorkoutId) === Number(w.id);

      const badge = isLive
        ? `<span class="badge live">LIVE</span>`
        : isViewing
          ? `<span class="badge">EDITING</span>`
          : "";

      const sum = w.summary || {};
      const setsCount = Number(sum.sets_count ?? 0);
      const exCount = Number(sum.exercises_count ?? 0);
      const meta = `${exCount} exercises • ${setsCount} sets`;

      return `
        <div class="workcard" data-wid="${escapeHtml(w.id)}">
          <div class="workcard-top">
            <div>
              <div class="workcard-title">${escapeHtml(fmtWorkoutTitle(w.started_at))}</div>
              <div class="workcard-meta">${escapeHtml(fmtWorkoutDate(w.started_at))}${w.ended_at ? ` → ${escapeHtml(fmtWorkoutDate(w.ended_at))}` : ""}</div>
              <div class="workcard-meta">${escapeHtml(meta)}</div>
            </div>
            ${badge}
          </div>
        </div>
      `;
    }).join("") || `<div class="muted">No workouts yet.</div>`;

    historyBox.querySelectorAll(".workcard").forEach((el) => {
      el.addEventListener("click", async () => {
        const wid = Number(el.getAttribute("data-wid"));
        if (!wid) return;

        const viewing = getViewingWorkoutId?.();
        if (viewing && Number(viewing) === wid) return;

        await onSelectWorkout?.(wid);
        await refreshHistory();
      });
    });
  }

  async function goPrev() {
    if (historyPage <= 1) return;
    historyPage--;
    await refreshHistory();
  }

  async function goNext() {
    if (historyPage >= historyPages) return;
    historyPage++;
    await refreshHistory();
  }

  return {
    refreshHistory,
    goPrev,
    goNext,
    getHistoryPage,
    getHistoryPages,
  };
}
