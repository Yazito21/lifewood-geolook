// GeoLook 采样助手 · 侧边栏
// 流程：载入队列 → 选题 → 填入问题(人按回车) → 答案生成完 → 提取 → 保存 → 上传/导出。

const $ = (s) => document.querySelector(s);
let QUEUE = { questions: [], platforms: [], groups: [] };
let SEL = null;            // 选中的题
let LAST = null;           // 最近一次提取结果
let SAMPLES = [];          // 已采集未上传
let GROUPS = [];           // 选中的意图分组（空 = 全部）

// 站点 → 平台码。识别不了的站让用户在下拉里自己选（下拉来自服务端平台清单）。
const HOST2PLAT = {
  "chatgpt.com": "chatgpt", "chat.openai.com": "chatgpt",
  "claude.ai": "claude_web",
  "doubao.com": "doubao_app",
  "google.com": "google_aio",
  "chat.baidu.com": "baidu", "yiyan.baidu.com": "baidu", "wenxin.baidu.com": "baidu",
  "metaso.cn": "metaso", "n.cn": "nano_ai",
  "n.cn": "nano_ai", "bot.n.cn": "nano_ai",
};

const store = {
  async get(k, d) { const o = await chrome.storage.local.get(k); return o[k] ?? d; },
  async set(k, v) { await chrome.storage.local.set({ [k]: v }); },
};

function serverUrl() { return $("#server").value.trim().replace(/\/$/, "") || "http://127.0.0.1:8765"; }
function slug() { return $("#slug").value; }

async function apiGet(path) {
  const r = await fetch(serverUrl() + path);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

// Sampling-environment notes. Most CN engines require sign-in, so incognito isn't always
// feasible — what matters isn't "was incognito on" but "what environment was this sample
// taken in, and was that recorded honestly."
const SESSION_NOTE = {
  sandbox: "A disposable sandbox launched by extension/sandbox.sh: no history, no cookies, signed out, wiped on close. Cleanest option for engines that need no sign-in (Baidu AI Search, Google AI Overviews, Metaso, Perplexity guest mode).",
  incognito: "Incognito + signed out — closest to what a stranger buyer would see. Note: incognito disables extensions by default (grant it separately in chrome://extensions), and unsaved samples are lost when the window closes.",
  clean_profile: "A dedicated Chrome profile used only for sampling — never search your own brand or click your own site, and turn off each engine's memory/personalization toggle. Use this for engines that require sign-in (Doubao, Kimi, Yuanbao, ChatGPT).",
  personal: "Your daily account carries history and personalization, so this measures \"how AI profiles you,\" not a stranger's view. These samples are automatically downgraded to \"needs review\" and don't count as trustworthy visibility evidence.",
};

function sessionMode() { return $("#session").value || "sandbox"; }

async function refreshDiscipline() {
  const el = $("#discipline"), sm = sessionMode();
  $("#sesnote").textContent = SESSION_NOTE[sm];
  const tab = await activeTab();
  const warns = [];
  // Only warn when "incognito" is selected but the window isn't actually incognito —
  // this doesn't apply when a dedicated profile is selected.
  if (sm === "incognito" && tab && !tab.incognito)
    warns.push("You selected \"incognito, signed out\" but this isn't an incognito window — switch to an incognito window, or change the sampling environment above to match what you're actually using");
  if (sm === "personal")
    warns.push("Sampling from a personal daily account: samples will be flagged \"needs review\" — don't draw visibility conclusions from them");
  warns.push("Open a new chat per question, no follow-ups; save the answer even if it doesn't mention the brand");
  el.hidden = false;
  el.innerHTML = warns.map(w => "· " + w).join("<br>");
  el.style.display = warns.length > 1 ? "" : "none";
}

async function detectPlatform() {
  const tab = await activeTab();
  let code = "";
  if (tab && tab.url) {
    try { code = HOST2PLAT[new URL(tab.url).hostname.replace(/^www\./, "")] || ""; } catch (e) {}
  }
  const known = QUEUE.platforms.find(p => p.code === code);
  $("#plat").textContent = known ? known.label : (code || "Unrecognized");
  if (known) $("#platSel").value = code;
}

function currentPlatform() {
  return $("#platSel").value || "";
}

function collectedKey(p, qid) { return `${p}::${qid}`; }

async function renderQueue() {
  const doneSet = new Set(SAMPLES.map(s => collectedKey(s.platform, s.question_id)));
  const p = currentPlatform();
  // Render sectioned by group so the same kind of question is sampled together, without switching context.
  const byGroup = {};
  QUEUE.questions.forEach(q => (byGroup[q.group || "Ungrouped"] = byGroup[q.group || "Ungrouped"] || []).push(q));
  const sections = Object.entries(byGroup).map(([g, list]) => {
    const left = list.filter(q => !doneSet.has(collectedKey(p, q.id))).length;
    return `<div class="small" style="color:var(--t600);margin:8px 0 2px">${g}
        <span style="color:var(--t500)">· ${left}/${list.length} left</span></div>` +
      list.map(q => `
        <div class="q ${SEL && SEL.id === q.id ? "sel" : ""}" data-id="${q.id}">
          <span class="id">${q.id}</span>${q.text}
          ${doneSet.has(collectedKey(p, q.id)) ? '<span class="done">✓ done</span>' : ""}
        </div>`).join("");
  }).join("");
  $("#qlist").innerHTML = sections || '<div class="muted" style="padding:8px">Click "Load queue" first</div>';
  document.querySelectorAll(".q").forEach(el => el.onclick = () => {
    SEL = QUEUE.questions.find(x => x.id === el.dataset.id);
    renderQueue();
  });
  $("#qmeta").textContent = QUEUE.questions.length
    ? `${QUEUE.brand} · ${QUEUE.questions.length} questions${GROUPS.length ? " (" + GROUPS.join("/") + ")" : ""}` : "";
}

async function loadProjects() {
  try {
    const ps = await apiGet("/api/projects");
    $("#slug").innerHTML = ps.map(p => `<option value="${p.slug}">${p.name}</option>`).join("");
    const saved = await store.get("slug");
    if (saved && ps.some(p => p.slug === saved)) $("#slug").value = saved;
  } catch (e) {
    $("#qmeta").textContent = "Can't reach the dashboard — start it first with geo.py ui";
  }
}

function renderGroups() {
  $("#groups").innerHTML = (QUEUE.groups || []).map(g => `
    <span class="chip ${GROUPS.includes(g.name) ? "on" : ""} ${g.buyer ? "buyer" : ""}"
      data-g="${g.name}" title="${g.buyer ? "Buyer-intent group — closest to a purchase decision" : "Education/probe group"}">${g.name}<span class="n">${g.count}</span></span>`).join("");
  document.querySelectorAll(".chip").forEach(el => el.onclick = async () => {
    const g = el.dataset.g;
    GROUPS = GROUPS.includes(g) ? GROUPS.filter(x => x !== g) : GROUPS.concat(g);
    await store.set("groups", GROUPS);
    loadQueue();
  });
}

async function loadQueue() {
  try {
    const qp = new URLSearchParams({ limit: "40" });
    if (GROUPS.length) qp.set("groups", GROUPS.join(","));
    else qp.set("intent", "buyer");     // Default to buyer intent when no group is picked, matching the weekly-sheet convention
    QUEUE = await apiGet(`/api/collect/queue/${slug()}?${qp}`);
    if (!GROUPS.length && QUEUE.selected && QUEUE.selected.length) GROUPS = QUEUE.selected;
    await store.set("slug", slug());
    $("#platSel").innerHTML = QUEUE.platforms
      .map(p => `<option value="${p.code}">${p.label}</option>`).join("");
    await detectPlatform();
    renderGroups();
    SEL = QUEUE.questions[0] || null;
    renderQueue();
  } catch (e) {
    $("#qmeta").textContent = "Load failed: " + e.message;
  }
}

async function sendToTab(msg) {
  const tab = await activeTab();
  if (!tab) return { ok: false, error: "No active tab found" };
  try { return await chrome.tabs.sendMessage(tab.id, msg); }
  catch (e) { return { ok: false, error: "No sampling script on this page (site isn't supported, or the page needs a refresh)" }; }
}

$("#load").onclick = loadQueue;
$("#platSel").onchange = renderQueue;
$("#pickbuyer").onclick = async () => {
  GROUPS = (QUEUE.groups || []).filter(g => g.buyer).map(g => g.name);
  await store.set("groups", GROUPS); loadQueue();
};
$("#pickall").onclick = async () => {
  GROUPS = (QUEUE.groups || []).map(g => g.name);
  await store.set("groups", GROUPS); loadQueue();
};

$("#copy").onclick = async () => {
  if (!SEL) return;
  await navigator.clipboard.writeText(SEL.text);
  $("#exmeta").textContent = "Copied — paste it into the page";
};

$("#fill").onclick = async () => {
  if (!SEL) return;
  const r = await sendToTab({ type: "geolook-fill", text: SEL.text });
  if (!r.ok) { await navigator.clipboard.writeText(SEL.text); }
  $("#exmeta").textContent = r.ok ? "Filled into the input box — review it, then press Enter yourself" : (r.error || "Fill failed, copied to clipboard instead");
};

$("#extract").onclick = async () => {
  if (!SEL) { $("#exmeta").textContent = "Pick a question first"; return; }
  const r = await sendToTab({ type: "geolook-extract" });
  if (!r.ok) { $("#exmeta").textContent = r.error || "Extraction failed"; $("#save").disabled = true; return; }
  LAST = r;
  $("#preview").hidden = false;
  $("#preview").textContent = r.answer.slice(0, 800) + (r.answer.length > 800 ? " …" : "");
  $("#exmeta").innerHTML = `<span class="okline">${r.mode === "selection" ? "From selection" : "Auto-extracted"} · ${r.answer.length} chars · ${r.citations.length} citation(s)</span>`;
  $("#save").disabled = false;
};

$("#save").onclick = async () => {
  if (!LAST || !SEL) return;
  const plat = currentPlatform();
  if (!plat) { $("#exmeta").textContent = "Pick the current engine in the dropdown above first"; return; }
  SAMPLES = SAMPLES.filter(s => !(s.platform === plat && s.question_id === SEL.id));
  SAMPLES.push({ platform: plat, question_id: SEL.id, question: SEL.text,
                 answer: LAST.answer, citations: LAST.citations, page_url: LAST.url,
                 session_mode: sessionMode(), ts: new Date().toISOString() });
  await store.set("samples:" + slug(), SAMPLES);
  LAST = null; $("#save").disabled = true; $("#preview").hidden = true;
  $("#exmeta").textContent = "Saved. Next question: open a new chat first.";
  // Auto-jump to the next un-sampled question
  const done = new Set(SAMPLES.map(s => collectedKey(s.platform, s.question_id)));
  SEL = QUEUE.questions.find(q => !done.has(collectedKey(plat, q.id))) || SEL;
  $("#count").textContent = SAMPLES.length;
  renderQueue();
};

/* ---------------- Auto-run queue ----------------
   You stay present, small batches, rate-limited, halts on any anomaly. This is
   "operating the page on your behalf," not "unattended crawling": closing the side
   panel stops it, switching tabs stops it, and any CAPTCHA/anti-bot signal halts
   it immediately and hands control back to you. */
let RUN = null;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function alog(msg, cls) {
  const el = document.createElement("div");
  el.className = cls || "";
  el.textContent = `${new Date().toTimeString().slice(0, 5)} ${msg}`;
  $("#autolog").prepend(el);
}

async function waitAnswer(tabId, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!RUN) return { state: "aborted" };
    await sleep(1500);
    let s;
    try { s = await chrome.tabs.sendMessage(tabId, { type: "geolook-status", stableMs: 2500 }); }
    catch (e) { continue; }              // Page is navigating — retry
    if (!s) continue;
    if (s.state === "blocked") return s;
    if (s.state === "done") return s;
  }
  return { state: "timeout" };
}

async function autoRun() {
  const plat = currentPlatform();
  if (!plat) { alog("Pick the current engine above first", "okline"); return; }
  const tab = await activeTab();
  if (!tab) return;
  if (sessionMode() === "incognito" && !tab.incognito &&
      !confirm("The sampling environment is set to \"incognito, signed out\", but this isn't an incognito window.\nContinuing will mislabel the sample environment — consider changing the sampling environment above first. Continue anyway?")) return;
  const ivl = Math.max(10, +$("#ivl").value || 25) * 1000;
  const cap = Math.max(1, Math.min(30, +$("#cap").value || 20));
  const done = new Set(SAMPLES.map(s => collectedKey(s.platform, s.question_id)));
  const todo = QUEUE.questions.filter(q => !done.has(collectedKey(plat, q.id))).slice(0, cap);
  if (!todo.length) { alog("This engine's queue is already fully sampled"); return; }
  if (!confirm(`This will auto-ask ${todo.length} question(s) in the current tab (${ivl / 1000}s apart).\nStay on the page throughout; click "Abort" anytime to stop.`)) return;

  RUN = { tabId: tab.id, plat, total: todo.length, i: 0, fails: 0 };
  $("#auto").hidden = true; $("#abort").hidden = false;
  alog(`Starting: ${todo.length} question(s) · ${plat}${GROUPS.length ? " · " + GROUPS.join("/") : ""}`);

  for (const q of todo) {
    if (!RUN) break;
    RUN.i++;
    // Open a new chat per question — follow-ups would let prior context taint later answers
    try {
      const nc = await chrome.tabs.sendMessage(RUN.tabId, { type: "geolook-newchat" });
      if (nc && nc.url) { await chrome.tabs.update(RUN.tabId, { url: nc.url }); await sleep(3500); }
    } catch (e) { /* Site isn't in the map — continue in place */ }
    if (!RUN) break;

    let sent;
    try { sent = await chrome.tabs.sendMessage(RUN.tabId, { type: "geolook-submit", text: q.text }); }
    catch (e) { sent = { ok: false, error: "No sampling script on the page" }; }
    if (!sent || !sent.ok) {
      RUN.fails++; alog(`[${RUN.i}/${RUN.total}] ${q.id} submit failed: ${(sent && sent.error) || "unknown"}`);
      if (RUN.fails >= 2) { alog("Stopped after 2 consecutive failures", "okline"); break; }
      continue;
    }
    alog(`[${RUN.i}/${RUN.total}] ${q.id} submitted, waiting for it to finish…`);

    const st = await waitAnswer(RUN.tabId, 120000);
    if (!RUN) break;
    if (st.state === "blocked") { alog("⚠ " + st.reason + " — stopped, please handle it manually", "okline"); break; }
    if (st.state !== "done") { RUN.fails++; alog(`[${RUN.i}] timed out waiting for the answer`); if (RUN.fails >= 2) break; continue; }

    let ex;
    try { ex = await chrome.tabs.sendMessage(RUN.tabId, { type: "geolook-extract" }); }
    catch (e) { ex = { ok: false, error: "Extraction failed" }; }
    if (!ex || !ex.ok) { RUN.fails++; alog(`[${RUN.i}] ${ex && ex.error}`); if (RUN.fails >= 2) break; continue; }

    RUN.fails = 0;
    SAMPLES = SAMPLES.filter(s => !(s.platform === plat && s.question_id === q.id));
    SAMPLES.push({ platform: plat, question_id: q.id, question: q.text, answer: ex.answer,
                   citations: ex.citations, page_url: ex.url,
                   session_mode: sessionMode(), ts: new Date().toISOString() });
    await store.set("samples:" + slug(), SAMPLES);
    $("#count").textContent = SAMPLES.length;
    renderQueue();
    alog(`[${RUN.i}/${RUN.total}] ✓ ${ex.answer.length} chars · ${ex.citations.length} citation(s)`, "okline");
    if (RUN.i < RUN.total) await sleep(ivl + Math.random() * 4000);
  }

  const finished = RUN ? RUN.i : 0;
  RUN = null;
  $("#auto").hidden = false; $("#abort").hidden = true;
  alog(`Done: ${finished} question(s) this round, ${SAMPLES.length} collected in total. Once checked, click "Upload to GeoLook".`, "okline");
}

$("#auto").onclick = autoRun;
$("#abort").onclick = () => { RUN = null; alog("Aborted"); $("#auto").hidden = false; $("#abort").hidden = true; };

$("#upload").onclick = async () => {
  if (!SAMPLES.length) { $("#upmsg").textContent = "No collected samples yet"; return; }
  try {
    const r = await fetch(`${serverUrl()}/api/collect/${slug()}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records: SAMPLES }),
    });
    const j = await r.json();
    if (j.ok) {
      $("#upmsg").textContent = `✓ Imported ${j.imported} sample(s) (grade-A manual evidence), metrics recomputed`;
      SAMPLES = []; await store.set("samples:" + slug(), []);
      $("#count").textContent = "0"; renderQueue();
    } else $("#upmsg").textContent = "Import failed: " + (j.error || r.status);
  } catch (e) { $("#upmsg").textContent = "Can't reach the dashboard: " + e.message; }
};

$("#export").onclick = () => {
  if (!SAMPLES.length) return;
  const byPlat = {};
  SAMPLES.forEach(s => (byPlat[s.platform] = byPlat[s.platform] || []).push(s));
  let md = `# ${QUEUE.brand || slug()} · extension sample export · ${new Date().toISOString().slice(0, 10)}\n\n`;
  for (const [p, list] of Object.entries(byPlat)) {
    md += `## platform: ${p}\n\n`;
    for (const s of list) {
      const cites = s.citations.map(c => `- ${c.url} ${c.title}`).join("\n");
      md += `### ${s.question_id} · ${s.question}\n\n\`\`\`answer\n${s.answer}\n${cites ? "\nCitations:\n" + cites + "\n" : ""}\`\`\`\n\n`;
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
  a.download = `geolook-samples-${Date.now()}.md`;
  a.click();
};

$("#session").onchange = async () => {
  await store.set("session", sessionMode());
  refreshDiscipline();
};

(async () => {
  await loadProjects();
  $("#session").value = await store.get("session", "sandbox");
  GROUPS = await store.get("groups", []);
  SAMPLES = await store.get("samples:" + slug(), []);
  $("#count").textContent = SAMPLES.length;
  await refreshDiscipline();
  chrome.tabs.onActivated.addListener(() => { refreshDiscipline(); detectPlatform(); });
  chrome.tabs.onUpdated.addListener((_, info) => { if (info.status === "complete") { refreshDiscipline(); detectPlatform(); } });
})();
