const API_AI_INTAKE = "./api/ai_intake.php";

const GROUPS = [
  { id:"abs_upper", label:"Abs (upper)" },
  { id:"abs_lower", label:"Abs (lower)" },
  { id:"obliques_external", label:"Obliques (external)" },
  { id:"obliques_internal", label:"Obliques (internal)" },
  { id:"core_deep", label:"Deep core (TVA)" },

  { id:"chest", label:"Chest" },
  { id:"lats", label:"Lats" },
  { id:"upper_back", label:"Upper back" },
  { id:"mid_back", label:"Mid back" },
  { id:"lower_back", label:"Lower back" },

  { id:"shoulders", label:"Shoulders" },
  { id:"front_delts", label:"Front delts" },
  { id:"side_delts", label:"Side delts" },
  { id:"rear_delts", label:"Rear delts" },

  { id:"biceps", label:"Biceps" },
  { id:"triceps", label:"Triceps" },
  { id:"forearms", label:"Forearms" },

  { id:"quads", label:"Quads" },
  { id:"hamstrings", label:"Hamstrings" },
  { id:"glutes", label:"Glutes" },
  { id:"calves", label:"Calves" },

  { id:"upper_traps", label:"Upper traps" },
  { id:"posterior_chain", label:"Posterior chain" },

  { id:"core", label:"Core" },
];

const aiForm = document.getElementById("aiForm");
const imageInput = document.getElementById("imageInput");
const textInput = document.getElementById("textInput");
const submitBtn = document.getElementById("submitBtn");
const resultBox = document.getElementById("resultBox");
const groupsBox = document.getElementById("groupsBox");

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function renderGroups() {
  groupsBox.innerHTML = GROUPS.map(g => `
    <div class="log">
      <div class="log-top">
        <div class="log-ex">${escapeHtml(g.label)}</div>
        <div class="log-date">${escapeHtml(g.id)}</div>
      </div>
    </div>
  `).join("");
}

renderGroups();

async function postMultipart({ file, text }) {
  const fd = new FormData();
  if (file) fd.append("image", file, file.name || "image.jpg");
  if (text) fd.append("text", text);

  const res = await fetch(API_AI_INTAKE, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    body: fd,
  });

  const raw = await res.text();
  let json;
  try { json = JSON.parse(raw); }
  catch { throw new Error(`Non-JSON from server:\n${raw.slice(0, 800)}`); }

  if (!res.ok || json?.ok === false) {
    throw new Error(json?.error || `HTTP ${res.status}`);
  }
  return json;
}

aiForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();

  const file = imageInput?.files?.[0] || null;
  const text = (textInput?.value || "").trim();

  if (!file && !text) {
    resultBox.textContent = "Add a photo and/or description.";
    return;
  }

  submitBtn.disabled = true;
  resultBox.textContent = "Working…";

  try {
    const json = await postMultipart({ file, text });
    resultBox.textContent = JSON.stringify(json, null, 2);

    // Seamless handoff back to index:
    // - if added: select it
    // - if exists: select it
    const ex = encodeURIComponent(json.id || "");
    if (ex) {
      window.location.href = `./index.html?ex=${ex}&added=1`;
    }
  } catch (e) {
    resultBox.textContent = String(e?.message || e);
  } finally {
    submitBtn.disabled = false;
  }
});
