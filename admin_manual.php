<?php
declare(strict_types=1);

require __DIR__ . "/api/db.php";
$uid = require_user_id();
if ($uid !== 1) {
  http_response_code(403);
  header("Location: ./login.html?reason=admin");
  exit;
}

header("Content-Type: text/html; charset=utf-8");
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Manual Admin</title>
  <link rel="stylesheet" href="./style.css" />
  <style>
    .admin-wrap { max-width: 1100px; margin: 0 auto; padding: 16px; }
    .admin-card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.12); border-radius: 14px; padding: 14px; margin-bottom: 14px; }
    .admin-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .admin-row-4 { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 10px; }
    label { display:block; font-size: 12px; opacity: 0.9; margin-bottom: 4px; }
    input[type="text"], input[type="number"], select, textarea {
      width: 100%;
      padding: 10px;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.15);
      background: rgba(0,0,0,0.25);
      color: inherit;
      outline: none;
    }
    textarea { min-height: 90px; resize: vertical; }
    .admin-actions { display:flex; gap:10px; flex-wrap: wrap; align-items:center; }
    .admin-actions button {
      padding: 10px 14px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.15);
      background: rgba(255,255,255,0.08);
      color: inherit;
      cursor: pointer;
      font-weight: 600;
    }
    .admin-actions button:hover { background: rgba(255,255,255,0.12); }
    .pill { display:inline-block; padding: 4px 8px; border-radius: 999px; font-size: 12px; border:1px solid rgba(255,255,255,0.15); opacity:0.95; }
    .ok { border-color: rgba(90,255,160,0.35); background: rgba(90,255,160,0.08); }
    .bad { border-color: rgba(255,90,90,0.35); background: rgba(255,90,90,0.08); }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 45vh;
      overflow: auto;
      padding: 12px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(0,0,0,0.35);
    }
    .muted { opacity: 0.75; font-size: 12px; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }

    /* Chat box */
    .chat { display:flex; flex-direction: column; gap:10px; }
    .chat-log {
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(0,0,0,0.30);
      border-radius: 12px;
      padding: 10px;
      max-height: 45vh;
      overflow: auto;
    }
    .msg { display:flex; margin: 6px 0; }
    .bubble {
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.14);
      max-width: 85%;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .msg.user { justify-content: flex-end; }
    .msg.user .bubble { background: rgba(120,180,255,0.12); }
    .msg.assistant { justify-content: flex-start; }
    .msg.assistant .bubble { background: rgba(255,255,255,0.06); }
    .chat-input { display:flex; gap:10px; }
    .chat-input textarea { min-height: 56px; margin:0; }
    .chat-input button { min-width: 110px; }

    .row-note { margin-top: 8px; }
  </style>
</head>
<body>
  <div class="admin-wrap">
    <h1 style="margin: 8px 0 14px 0;">Manual Admin</h1>
    <div class="admin-card">
      <div class="muted">Hidden page. Only user_id=1 can access. No links from main UI.</div>
      <div class="muted mono">Project root: /var/www/html/musclemap</div>
    </div>

    <div class="admin-card">
      <h2 style="margin: 0 0 10px 0;">Runner settings</h2>

      <div class="admin-row">
        <div>
          <label for="model">Model</label>
          <select id="model">
            <option value="grok-4-1-fast-reasoning">grok-4-1-fast-reasoning</option>
            <option value="grok-4-0709">grok-4-0709</option>
          </select>
        </div>
        <div>
          <label for="out">Output file</label>
          <input id="out" type="text" value="MANUAL.md" />
        </div>
      </div>

      <div style="height:10px;"></div>

      <div class="admin-row-4">
        <div>
          <label for="chunk_tokens">chunk-tokens</label>
          <input id="chunk_tokens" type="number" min="1000" max="50000" value="12000" />
        </div>
        <div>
          <label for="max_rounds">max-rounds</label>
          <input id="max_rounds" type="number" min="1" max="100" value="20" />
        </div>
        <div>
          <label for="timeout">timeout (sec)</label>
          <input id="timeout" type="number" min="5" max="1800" value="240" />
        </div>
        <div>
          <label for="max_attempts">max-attempts</label>
          <input id="max_attempts" type="number" min="1" max="50" value="5" />
        </div>
      </div>

      <div class="muted row-note">
        Live output is shown while running (polling). You’ll see progress / retries / failures without waiting for completion.
      </div>

      <div style="height:10px;"></div>

      <div class="admin-actions">
        <label class="muted" style="display:flex;gap:8px;align-items:center;">
          <input id="debug" type="checkbox" /> debug
        </label>
        <label class="muted" style="display:flex;gap:8px;align-items:center;">
          <input id="db" type="checkbox" /> db dump
        </label>
        <label class="muted" style="display:flex;gap:8px;align-items:center;">
          <input id="use_existing" type="checkbox" checked /> use existing manual
        </label>

        <button id="btn_run">Regenerate / Print</button>
        <button id="btn_preview">Preview MANUAL.md</button>
        <span id="status" class="pill ok">idle</span>
      </div>
      <div class="muted" style="margin-top:8px;">
        For chat questions, the UI always appends Q&A to the manual (uses existing manual).
      </div>
    </div>

    <div class="admin-card">
      <h2 style="margin: 0 0 10px 0;">Q&A Chat</h2>
      <div class="chat">
        <div id="chat_log" class="chat-log mono"></div>
        <div class="chat-input">
          <textarea id="chat_text" placeholder="Ask a dev question about this project..."></textarea>
          <button id="chat_send">Send</button>
          <button id="chat_clear">Clear</button>
        </div>
        <div class="muted">Replies are the exact markdown block appended under “## Q&A” (from the manual tool).</div>
      </div>
    </div>

    <div class="admin-card">
      <h2 style="margin: 0 0 10px 0;">Last run output</h2>
      <pre id="out_pre" class="mono">(no output yet)</pre>
    </div>

    <div class="admin-card">
      <h2 style="margin: 0 0 10px 0;">Manual preview</h2>
      <pre id="manual_pre" class="mono">(click Preview MANUAL.md)</pre>
    </div>
  </div>

<script>
(function(){
  const $ = (id) => document.getElementById(id);

  function setStatus(ok, text){
    const el = $("status");
    el.textContent = text;
    el.classList.remove("ok","bad");
    el.classList.add(ok ? "ok" : "bad");
  }

  async function fetchManual(){
    try {
      const r = await fetch("./MANUAL.md", { cache: "no-store", credentials: "same-origin" });
      const t = await r.text();
      $("manual_pre").textContent = t;
      return true;
    } catch (e) {
      $("manual_pre").textContent = String(e);
      return false;
    }
  }

  function buildBasePayload(){
    return {
      model: $("model").value,
      out: $("out").value.trim() || "MANUAL.md",
      debug: $("debug").checked ? 1 : 0,
      db: $("db").checked ? 1 : 0,
      use_existing_manual: $("use_existing").checked ? 1 : 0,
      chunk_tokens: Number($("chunk_tokens").value || 12000),
      max_rounds: Number($("max_rounds").value || 20),
      timeout: Number($("timeout").value || 240),
      max_attempts: Number($("max_attempts").value || 3),
      json: 1
    };
  }

  function chatLoad(){
    try {
      const s = localStorage.getItem("mm_admin_chat");
      const arr = s ? JSON.parse(s) : [];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
  function chatSave(arr){
    localStorage.setItem("mm_admin_chat", JSON.stringify(arr.slice(-100)));
  }
  function chatRender(arr){
    const log = $("chat_log");
    log.innerHTML = "";
    for (const m of arr) {
      const row = document.createElement("div");
      row.className = "msg " + (m.role === "user" ? "user" : "assistant");
      const b = document.createElement("div");
      b.className = "bubble";
      b.textContent = m.text || "";
      row.appendChild(b);
      log.appendChild(row);
    }
    log.scrollTop = log.scrollHeight;
  }

  function setOut(text){
    const pre = $("out_pre");
    pre.textContent = text || "";
    pre.scrollTop = pre.scrollHeight;
  }

  let CHAT = chatLoad();
  chatRender(CHAT);

  let RUN_POLL = null;
  function stopPoll(){
    if (RUN_POLL) {
      clearInterval(RUN_POLL);
      RUN_POLL = null;
    }
  }

  async function pollRun(runId, onDone){
    stopPoll();

    async function tick(){
      try{
        const r = await fetch("./api/admin_manual_trigger.php?status=1&run_id=" + encodeURIComponent(runId), {
          cache: "no-store",
          credentials: "same-origin"
        });
        const data = await r.json().catch(() => null);
        if (!data || data.ok !== true) {
          setStatus(false, "poll error");
          return;
        }

        setOut(data.tail || "");

        if (data.running) {
          setStatus(true, "running...");
          return;
        }

        // done
        stopPoll();

        const ok = !!data.done_ok;
        if (ok) setStatus(true, "done (exit " + data.exit_code + ")");
        else setStatus(false, "failed (exit " + data.exit_code + ")");

        // show a final combined output (still capped by server)
        if (typeof data.final_output === "string" && data.final_output.trim() !== "") {
          setOut(data.final_output);
        }

        await fetchManual();
        if (typeof onDone === "function") onDone(data);
      } catch(e){
        setStatus(false, "poll exception");
        setOut(String(e));
        stopPoll();
      }
    }

    await tick();
    RUN_POLL = setInterval(tick, 1000);
  }

  async function startAsync(payload, onDone){
    setStatus(true, "starting...");
    setOut("(starting...)");

    try{
      const r = await fetch("./api/admin_manual_trigger.php", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(Object.assign({}, payload, { start_async: 1 }))
      });

      const data = await r.json().catch(() => null);
      if (!data || data.ok !== true || !data.run_id) {
        setOut(JSON.stringify(data || { ok:false, error:"bad_response" }, null, 2));
        setStatus(false, "error");
        return;
      }

      setStatus(true, "running...");
      await pollRun(data.run_id, onDone);
    } catch(e){
      setOut(String(e));
      setStatus(false, "exception");
    }
  }

  async function run(){
    const payload = buildBasePayload();
    payload.question = ""; // runner mode
    await startAsync(payload, null);
  }

  async function chatSend(){
    const text = $("chat_text").value.trim();
    if (!text) return;

    CHAT.push({ role: "user", text });
    chatSave(CHAT);
    chatRender(CHAT);

    $("chat_text").value = "";
    $("chat_send").disabled = true;
    setStatus(true, "asking...");
    setOut("(asking...)");

    const payload = buildBasePayload();
    payload.use_existing_manual = 1; // always for chat
    payload.question = text;

    await startAsync(payload, (doneData) => {
      try{
        const sj = doneData && doneData.script_json ? doneData.script_json : null;
        const answer = (sj && sj.output) ? sj.output : "(no script_json.output)";
        CHAT.push({ role: "assistant", text: answer });
      } catch (e) {
        CHAT.push({ role: "assistant", text: String(e) });
      }
      chatSave(CHAT);
      chatRender(CHAT);
      $("chat_send").disabled = false;
    });

    // if startAsync errors before onDone runs:
    $("chat_send").disabled = false;
  }

  $("btn_run").addEventListener("click", run);
  $("btn_preview").addEventListener("click", async () => {
    setStatus(true, "loading manual...");
    const ok = await fetchManual();
    setStatus(ok, ok ? "manual loaded" : "manual load failed");
  });

  $("chat_send").addEventListener("click", chatSend);
  $("chat_clear").addEventListener("click", () => {
    CHAT = [];
    chatSave(CHAT);
    chatRender(CHAT);
  });

  $("chat_text").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") chatSend();
  });
})();
</script>

</body>
</html>
