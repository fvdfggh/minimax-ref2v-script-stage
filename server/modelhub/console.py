"""自带控制台：一个 HTML，不依赖任何 CDN。

它不是装饰品。单卡动态加载这种事，出问题时最需要看的就是三样：
这张卡现在被谁占着、下一个请求会卸掉谁、上次加载到底卡在哪一步。
这三样在 JSON 里都有，但盯着 JSON 排查太慢，所以给一个页面。

页面只用浏览器原生能力（fetch / EventSource），离线可用。
"""

CONSOLE_HTML = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ModelHub · 单卡模型服务</title>
<style>
  :root {
    --bg: #0e1319;
    --panel: #171e26;
    --panel-2: #1e2731;
    --line: #2a3542;
    --text: #dbe4ee;
    --muted: #8395a7;
    --accent: #4ea1ff;
    --ok: #3ecf8e;
    --warn: #f0b429;
    --err: #ef5a5a;
    --mono: "Cascadia Mono", "JetBrains Mono", Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  header {
    display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
    padding: 18px 24px; border-bottom: 1px solid var(--line);
    background: linear-gradient(180deg, #16202b, #0e1319);
    position: sticky; top: 0; z-index: 5;
  }
  h1 { font-size: 17px; margin: 0; letter-spacing: .4px; font-weight: 600; }
  .sub { color: var(--muted); font-size: 12px; }
  .spacer { flex: 1; }
  .badge {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 9px; border-radius: 999px; font-size: 12px;
    border: 1px solid var(--line); background: var(--panel-2); color: var(--muted);
  }
  .badge.single { border-color: #2b5f8a; color: #8dc6ff; background: #12283a; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
  .dot.ok { background: var(--ok); box-shadow: 0 0 0 3px rgba(62,207,142,.15); }
  .dot.err { background: var(--err); box-shadow: 0 0 0 3px rgba(239,90,90,.15); }
  button {
    font: inherit; font-size: 12px; color: var(--text); cursor: pointer;
    background: var(--panel-2); border: 1px solid var(--line);
    padding: 6px 12px; border-radius: 7px; transition: .15s;
  }
  button:hover { border-color: #3d5165; background: #24303c; }
  button.primary { background: #1c4f80; border-color: #2b6da8; color: #dceeff; }
  button.primary:hover { background: #225d95; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  main { padding: 20px 24px 60px; max-width: 1280px; margin: 0 auto; }
  .grid { display: grid; gap: 14px; grid-template-columns: minmax(0, 1fr); }
  /* grid item 默认 min-width:auto，长内容会把列顶宽；归零才会按轨道走 */
  .grid > * { min-width: 0; }
  .card {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 12px; padding: 16px;
  }
  .card h2 {
    margin: 0 0 12px; font-size: 13px; font-weight: 600; color: #b9c7d6;
    letter-spacing: .5px; display: flex; align-items: center; gap: 8px;
  }
  /* 宽屏：左边账本固定 380，右边能力自适应；其余卡片横跨整行 */
  @media (min-width: 1000px) {
    .grid { grid-template-columns: 380px minmax(0, 1fr); }
  }
  .gpu { align-self: start; }
  .full { grid-column: 1 / -1; }
  /* 能力卡用 flex 排：卡片最小 210，容器宽了就自动多放一张 */
  .caps { display: flex; flex-wrap: wrap; gap: 10px; align-content: flex-start; }
  .cap {
    flex: 1 1 210px; min-width: 190px;
    background: var(--panel-2); border: 1px solid var(--line);
    border-radius: 10px; padding: 12px 13px; display: flex; flex-direction: column; gap: 8px;
  }
  .cap.ready { border-color: #2c6b4f; box-shadow: inset 0 0 0 1px rgba(62,207,142,.12); }
  .cap.error { border-color: #6d2f2f; }
  .cap .top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .cap .name { font-weight: 600; white-space: nowrap; flex: 0 0 auto; }
  .cap .tag {
    font-size: 11px; color: var(--muted); border: 1px solid var(--line);
    padding: 1px 6px; border-radius: 5px; white-space: nowrap; flex: 0 0 auto;
  }
  .cap .model { color: #9fb2c4; font-size: 12px; font-family: var(--mono); }
  .cap .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; color: var(--muted); }
  .cap .actions { display: flex; gap: 6px; margin-top: auto; }
  .cap .actions button { white-space: nowrap; flex: 0 0 auto; }
  .state { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line); white-space: nowrap; }
  .state.ready { color: var(--ok); border-color: #2c6b4f; background: rgba(62,207,142,.08); }
  .state.loading { color: var(--warn); border-color: #6d5726; background: rgba(240,180,41,.08); }
  .state.error { color: var(--err); border-color: #6d2f2f; background: rgba(239,90,90,.08); }
  .state.idle { color: var(--muted); }
  .meter { height: 8px; border-radius: 999px; background: #0b1016; overflow: hidden; display: flex; }
  .meter i { display: block; height: 100%; }
  .meter .others { background: #4a5a6b; }
  .meter .hub { background: var(--accent); }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; font-size: 12px; margin-top: 10px; }
  .kv b { color: var(--muted); font-weight: 400; }
  .kv span { font-family: var(--mono); color: #c6d4e2; text-align: right; }
  .legend { display: flex; gap: 14px; font-size: 11px; color: var(--muted); margin-top: 8px; }
  .legend i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; }
  .policy {
    margin-top: 14px; padding-top: 12px; border-top: 1px dashed var(--line);
    font-size: 12px; line-height: 1.7; color: var(--muted);
  }
  .policy b { color: #a9bfd4; font-weight: 600; }
  pre {
    margin: 0; font-family: var(--mono); font-size: 12px; line-height: 1.55;
    white-space: pre-wrap; word-break: break-word; color: #b7c6d6;
    max-height: 260px; overflow: auto;
  }
  .checks { display: flex; flex-direction: column; gap: 6px; }
  .chk { display: flex; gap: 8px; font-size: 12px; line-height: 1.5; }
  .chk .lvl { flex: 0 0 auto; font-size: 10px; padding: 1px 6px; border-radius: 4px; height: 18px; }
  .chk .lvl.error { background: rgba(239,90,90,.14); color: var(--err); }
  .chk .lvl.warn { background: rgba(240,180,41,.14); color: var(--warn); }
  .chk .lvl.info { background: rgba(78,161,255,.12); color: #7cb8ff; }
  .chk .msg { color: #c3d0de; }
  .chk .hint { color: var(--muted); }
  .full { grid-column: span 12; }
  .feed { display: flex; flex-direction: column; gap: 2px; max-height: 260px; overflow: auto; font-family: var(--mono); font-size: 12px; }
  .ev { display: flex; gap: 10px; padding: 3px 0; border-bottom: 1px dashed #212b36; }
  .ev .t { color: #5c6d7e; flex: 0 0 66px; }
  .ev .k { flex: 0 0 92px; color: #7fb3e8; }
  .ev .d { color: #a9bbc9; }
  .empty { color: var(--muted); font-size: 12px; padding: 8px 0; }
  .toast {
    position: fixed; right: 20px; bottom: 20px; max-width: 460px;
    background: #222c38; border: 1px solid var(--line); border-left: 3px solid var(--accent);
    padding: 10px 14px; border-radius: 8px; font-size: 12px; color: #d7e3ef;
    opacity: 0; transform: translateY(8px); transition: .2s; pointer-events: none;
  }
  .toast.show { opacity: 1; transform: none; }
  .toast.err { border-left-color: var(--err); }
  .dry { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
  .dry input {
    background: #0b1016; border: 1px solid var(--line); color: var(--text);
    border-radius: 7px; padding: 6px 10px; font: inherit; font-size: 12px; flex: 1; min-width: 180px;
  }
  /* 卡上现在是谁 —— 严格轮转下最多一个，所以这里就是「谁在算」 */
  .hot { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 12px; margin-bottom: 10px; }
  .hot .chip {
    border: 1px solid #2f6fd0; background: #12243a; color: #d6e8ff;
    padding: 3px 9px; border-radius: 999px;
  }
  .hot .chip.busy { border-color: #3ecf8e; background: #10291f; color: #c9f6e2; }
  .hot .none { color: var(--muted); }
  .hot .swap { color: var(--muted); margin-left: auto; }
</style>
</head>
<body>
<header>
  <h1>ModelHub</h1>
  <span class="badge single" title="整份服务只用一张卡">单卡 · GPU <b id="gpuIdx">-</b></span>
  <span class="badge"><span class="dot" id="dot"></span><span id="hstat">连接中</span></span>
  <span class="sub" id="uptime"></span>
  <span class="spacer"></span>
  <button class="primary" id="btn-pre">运行前体检</button>
  <button id="btn-refresh">刷新</button>
  <button id="btn-unload">全部卸载</button>
</header>
<main>
  <div class="grid">
    <section class="card gpu">
      <h2>显存账本 <span class="sub" id="gpuName"></span></h2>
      <div class="hot" id="hot"></div>
      <div class="meter"><i class="others" id="m-others"></i><i class="hub" id="m-hub"></i></div>
      <div class="legend">
        <span><i style="background:#4a5a6b"></i>别人占</span>
        <span><i style="background:#4ea1ff"></i>本服务模型</span>
        <span><i style="background:#0b1016;border:1px solid #2a3542"></i>保留/空闲</span>
      </div>
      <div class="kv" id="ledger"></div>
      <div class="policy" id="policy"></div>
    </section>

    <section class="caps-wrap card">
      <h2>能力</h2>
      <div class="caps" id="caps"><div class="empty">读取中…</div></div>
    </section>

    <section class="card full" id="pre-card" style="display:none">
      <h2>体检结果 <span class="sub" id="pre-sum"></span></h2>
      <div class="checks" id="pre-checks"></div>
      <pre id="pre-advice" style="margin-top:10px;color:#9fb2c4"></pre>
    </section>

    <section class="card full">
      <h2>试跑 <span class="sub">走 /v1/run，和上层用同一条路</span></h2>
      <div class="dry">
        <input id="cap" value="text.generate" />
        <input id="payload" placeholder='{"prompt":"说一句话"}' value='{"messages":[{"role":"user","content":"用一句话说明你在哪张卡上跑"}]}' />
        <button id="btn-run">跑一次</button>
      </div>
      <pre id="run-out" style="max-height:220px"></pre>
    </section>

    <section class="card full">
      <h2>事件 <span class="sub">加载 / 让位 / 调用</span></h2>
      <div class="feed" id="feed"><div class="empty">还没有事件</div></div>
    </section>
  </div>
</main>
<div class="toast" id="toast"></div>
<script>
const $ = (id) => document.getElementById(id);
const fmt = (n) => (n == null ? "-" : Number(n).toLocaleString("en-US"));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
let toastTimer = null;
function toast(msg, isErr) {
  const el = $("toast");
  el.textContent = msg;
  el.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "toast"; }, 4200);
}
async function api(path, opts) {
  const res = await fetch(path, Object.assign({headers: {"Content-Type": "application/json"}}, opts || {}));
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = {ok: false, error: text.slice(0, 400)}; }
  // 只看 HTTP 状态：体检不通过时 body 里 ok=false，但请求本身是成功的
  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}
const STATE_TXT = {idle: "未加载", loading: "加载中", ready: "已就绪", unloading: "卸载中", error: "出错"};
const DRV = {comfy: "ComfyUI", audiocpp: "audio.cpp", s2: "s2.cpp", llama: "llama.cpp"};
function capCard(m) {
  const cls = m.state === "ready" ? "ready" : m.state === "error" ? "error" : "";
  const vram = m.realVramMb
    ? fmt(m.realVramMb) + " MB（实测）"
    : (m.driver === "comfy" ? "随工作流动态"
      : (m.estVramMb ? "≈" + fmt(m.estVramMb) + " MB" : "外部管理"));
  return `<div class="cap ${cls}" data-id="${esc(m.id)}">
    <div class="top">
      <span class="name">${esc(m.capabilityTitle)}</span>
      <span class="tag" title="${esc(m.driverTitle)}">${esc(DRV[m.driver] || m.driverTitle)}</span>
      <span class="spacer"></span>
      <span class="state ${esc(m.state)}">${esc(STATE_TXT[m.state] || m.state)}</span>
    </div>
    <div class="model">${esc(m.title)}</div>
    <div class="row"><span>显存 ${vram}</span><span>${m.refs ? "在用 " + m.refs : ""}</span><span>${m.port ? "端口 " + m.port : ""}</span></div>
    ${m.error ? `<div class="row" style="color:var(--err)">${esc(String(m.error).slice(0,160))}</div>` : ""}
    <div class="actions">
      <button data-act="load" data-id="${esc(m.id)}" ${m.state === "loading" ? "disabled" : ""}>加载</button>
      <button data-act="unload" data-id="${esc(m.id)}" ${m.state === "idle" ? "disabled" : ""}>卸载</button>
    </div>
  </div>`;
}
async function refresh() {
  try {
    const st = await api("/v1/status");
    const env = await api("/v1/env");
    $("dot").className = "dot ok";
    $("hstat").textContent = "运行中";
    $("gpuIdx").textContent = st.gpu.index;
    $("uptime").textContent = env.uptimeSec < 60 ? "已运行 " + env.uptimeSec + " 秒" : "已运行 " + Math.floor(env.uptimeSec / 60) + " 分钟";
    const g = st.gpu.stats || {};
    $("gpuName").textContent = (g.name || "读不到显卡") + (g.totalMb ? " · " + fmt(g.totalMb) + " MB" : "");
    const L = st.ledger || {};
    const total = L.totalMb || g.totalMb || 1;
    const others = L.othersMb || 0, hub = L.hubMb || 0;
    $("m-others").style.width = Math.min(100, (others / total) * 100) + "%";
    $("m-hub").style.width = Math.min(100, (hub / total) * 100) + "%";
    const rows = [
      ["总显存", fmt(L.totalMb) + " MB"],
      ["别人占用", fmt(others) + " MB"],
      ["本服务模型", fmt(hub) + " MB"],
      ["保留", fmt(L.reservedMb) + " MB"],
      ["可用预算", fmt(L.budgetMb) + " MB"],
      ["现在还能装", fmt(L.freeForHubMb) + " MB"]
    ];
    $("ledger").innerHTML = rows.map(([k, v]) => `<b>${k}</b><span>${v}</span>`).join("");
    const rot = st.rotation || {};
    const hot = (rot.hot || []).map((h) =>
      `<span class="chip${h.busy ? " busy" : ""}" title="${esc(h.capabilityTitle)}">${esc(h.title)}` +
      `${h.busy ? " · 调用中" : ""}<b style="opacity:.65"> ${fmt(h.mb)}MB</b></span>`).join("");
    const last = rot.last
      ? `上次换人：${esc((rot.last.fromTitles || []).join("、"))} → ${esc(rot.last.toTitle)} · ` +
        `${(rot.last.ms / 1000).toFixed(1)}s · 累计 ${rot.swaps} 次`
      : "还没换过模型";
    $("hot").innerHTML = `<span style="color:var(--muted)">卡上现在：</span>` +
      `${hot || '<span class="none">空</span>'}<span class="swap">${last}</span>`;
    $("policy").innerHTML = rot.exclusive
      ? `严格轮转：整份服务只用 <b>GPU ${st.gpu.index}</b>，<b>卡上只留正在用的那一个</b>。` +
        `轮到谁就把谁搬上来，之前那个（连 ComfyUI 进程一起）先撤下去；` +
        `那次请求还没跑完就等它 ${rot.swapWaitSec}s，仍不空就报 409 说清是谁在占。`
      : `共享模式：只用 <b>GPU ${st.gpu.index}</b>，装得下就都留着，装不下才按 LRU 卸（正在被调用的不动）。`;
    $("caps").innerHTML = (st.slots || []).map(capCard).join("");
  } catch (e) {
    $("dot").className = "dot err";
    $("hstat").textContent = "连不上";
    toast(e.message, true);
  }
}
async function preflight() {
  const btn = $("btn-pre");
  btn.disabled = true;
  try {
    const r = await api("/v1/preflight", {method: "POST", body: JSON.stringify({})});
    $("pre-card").style.display = "block";
    $("pre-sum").textContent = r.ok ? "全部就绪" : (r.blockers.length + " 项阻断");
    const rows = [];
    for (const c of r.capabilities) {
      for (const k of c.checks) {
        rows.push(`<div class="chk"><span class="lvl ${k.level}">${k.level === "error" ? "阻断" : k.level === "info" ? "说明" : "提醒"}</span>
          <span class="msg"><b>${esc(c.title)}</b> · ${esc(k.message)}${k.hint ? `<span class="hint"> — ${esc(k.hint)}</span>` : ""}</span></div>`);
      }
      if (!c.checks.length) {
        rows.push(`<div class="chk"><span class="lvl" style="background:rgba(62,207,142,.14);color:var(--ok)">可用</span>
          <span class="msg"><b>${esc(c.title)}</b> · ${esc(c.modelTitle)}${c.willEvict && c.willEvict.length ? "（会先卸 " + c.willEvict.map(x => esc(x.title)).join("、") + "）" : ""}</span></div>`);
      }
    }
    $("pre-checks").innerHTML = rows.join("") || '<div class="empty">没有问题</div>';
    $("pre-advice").textContent = (r.advice || []).join("\n");
    toast(r.ok ? "体检通过" : "有 " + r.blockers.length + " 项阻断", !r.ok);
    refresh();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}
async function act(id, what) {
  try {
    await api(what === "load" ? `/v1/models/${encodeURIComponent(id)}/load` : `/v1/models/${encodeURIComponent(id)}/unload`, {method: "POST", body: "{}"});
    toast((what === "load" ? "已加载 " : "已卸载 ") + id);
    refresh();
  } catch (e) { toast(e.message, true); }
}
async function unloadAll() {
  try {
    const r = await api("/v1/unload", {method: "POST", body: JSON.stringify({all: true})});
    toast("卸载 " + (r.unloaded || []).length + " 个");
    refresh();
  } catch (e) { toast(e.message, true); }
}
async function runOnce() {
  let payload;
  try { payload = JSON.parse($("payload").value); } catch (e) { toast("输入不是合法 JSON", true); return; }
  $("run-out").textContent = "…";
  const t0 = performance.now();
  try {
    const r = await api("/v1/run", {method: "POST", body: JSON.stringify({capability: $("cap").value.trim(), input: payload})});
    const dt = Math.round(performance.now() - t0);
    const copy = Object.assign({}, r);
    if (typeof copy.data === "string" && copy.data.length > 600) copy.data = copy.data.slice(0, 600) + "…（base64 截断）";
    $("run-out").textContent = dt + "ms\n" + JSON.stringify(copy, null, 2);
    refresh();
  } catch (e) {
    $("run-out").textContent = "失败：" + e.message;
  }
}
const KIND_TXT = {load: "加载", "load.start": "开始加载", "load.ready": "加载完成", "load.done": "加载完成",
  "load.error": "加载失败", "unload.done": "已卸载", "unload.error": "卸载失败", "invoke.done": "调用完成",
  "invoke.error": "调用失败", "hub.start": "服务启动", "hub.stop": "服务停止", "hub.orphans": "清理残留",
  "swap.begin": "开始换人", "swap.wait": "等前一个跑完", "swap.done": "换人完成"};
function pushEvent(ev) {
  const feed = $("feed");
  if (feed.querySelector(".empty")) feed.innerHTML = "";
  const t = new Date(ev.at);
  const hh = String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0") + ":" + String(t.getSeconds()).padStart(2, "0");
  const bits = [];
  if (ev.model) bits.push(ev.model);
  if (ev.from_ && ev.from_.length) bits.push("换下 " + ev.from_.join("、"));
  if (ev.busy && ev.busy.length) bits.push("等 " + ev.busy.join("、") + "(" + (ev.waitSec || 0) + "s)");
  if (ev.ms != null) bits.push(ev.ms + "ms");
  if (ev.vramMb) bits.push(fmt(ev.vramMb) + "MB");
  if (ev.reason) bits.push(ev.reason);
  if (ev.error) bits.push(String(ev.error).slice(0, 120));
  const row = document.createElement("div");
  row.className = "ev";
  row.innerHTML = `<span class="t">${hh}</span><span class="k">${esc(KIND_TXT[ev.kind] || ev.kind)}</span><span class="d">${esc(bits.join(" · "))}</span>`;
  feed.prepend(row);
  while (feed.children.length > 120) feed.lastChild.remove();
}
function connect() {
  // 先把最近事件拉出来填上，不然刚打开页面永远是「还没有事件」
  api("/v1/events?limit=25")
    .then((h) => (h.events || []).forEach(pushEvent))
    .catch(() => {});
  const es = new EventSource("/v1/events");
  es.onmessage = (m) => { try { pushEvent(JSON.parse(m.data)); } catch (e) {} };
  es.onerror = () => { $("dot").className = "dot err"; $("hstat").textContent = "事件流断开"; };
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]");
  if (b) act(b.dataset.id, b.dataset.act);
});
$("btn-refresh").onclick = refresh;
$("btn-pre").onclick = preflight;
$("btn-unload").onclick = unloadAll;
$("btn-run").onclick = runOnce;
refresh();
preflight();
connect();
setInterval(refresh, 8000);
</script>
</body>
</html>
"""
