// 悬浮窗渲染逻辑（无框架、无 import，tsc 直出浏览器可用 JS）
interface RowVM {
  tool: string;
  sessionId: string;
  name: string;
  state: string;
  statusLabel: string;
  duration: string;
  highlight: boolean;
  canIgnore: boolean;
  canAcknowledge: boolean;
  missedQuestion: boolean;
}

interface StatePayload {
  aggregate: { color: string; counts: Record<string, number> };
  detail: { rows: RowVM[] };
  dbDegraded: boolean;
  breathing: boolean;
  lang: string;
}

const $ = (id: string) => document.getElementById(id)!;
let expanded = false;
let last: StatePayload | null = null;
/** 展开时按灯色过滤：red→failed，yellow→waiting，green→running */
let filter: "red" | "yellow" | "green" | null = null;

/** 正常完成的会话不再展示；带错过提问标记的完成会话保留入口（挂在绿灯视图） */
function filterRows(rows: RowVM[], color: "red" | "yellow" | "green"): RowVM[] {
  switch (color) {
    case "red":
      return rows.filter((r) => r.state === "failed");
    case "yellow":
      return rows.filter((r) => r.state === "waiting");
    case "green":
      return rows.filter((r) => r.state === "running" || (r.state === "idle" && r.missedQuestion));
  }
}

const LABELS: Record<string, Record<string, string>> = {
  zh: { ignore: "忽略", ack: "知悉", missed: "有提问被自动处理，点击清除", degraded: "DB 通道降级：黄灯改用启发式", empty: "该状态暂无会话" },
  en: { ignore: "Ignore", ack: "Ack", missed: "A question was auto-handled, click to clear", degraded: "DB degraded: heuristic yellow", empty: "No sessions in this state" },
};

function lamp(color: "red" | "yellow" | "green", count: number, breathing: boolean): void {
  const el = $(`lamp-${color}`);
  const badge = $(`badge-${color}`);
  el.classList.toggle("on", count > 0);
  el.classList.toggle("breathing", color === "yellow" && count > 0 && breathing);
  badge.style.display = count > 0 ? "block" : "none";
  badge.textContent = String(count);
}

function makeRow(r: RowVM, lang: string): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "row" + (r.highlight ? " highlight" : "");
  const dot = document.createElement("span");
  dot.className = `dot ${r.state}`;
  li.appendChild(dot);
  if (r.missedQuestion) {
    const ring = document.createElement("span");
    ring.className = "missed-ring";
    ring.title = LABELS[lang].missed;
    ring.onclick = () => void tl.action("clearMark", r.tool, r.sessionId);
    li.appendChild(ring);
  }
  const tag = document.createElement("span");
  tag.className = "tool-tag";
  tag.textContent = r.tool;
  li.appendChild(tag);
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = r.name;
  // 截断名称悬浮展示全名（原生 title 在置顶无框窗不可靠，用面板内 toast）
  name.onmouseenter = () => {
    if (name.scrollWidth > name.clientWidth) showNameToast(r.name, li);
  };
  name.onmouseleave = hideToast;
  li.appendChild(name);
  const status = document.createElement("span");
  status.className = "status";
  status.textContent = `${r.statusLabel} ${r.duration}`;
  li.appendChild(status);
  if (r.canIgnore) {
    const b = document.createElement("button");
    b.textContent = LABELS[lang].ignore;
    b.onclick = () => void tl.action("ignore", r.tool, r.sessionId);
    li.appendChild(b);
  }
  if (r.canAcknowledge) {
    const b = document.createElement("button");
    b.textContent = LABELS[lang].ack;
    b.onclick = () => void tl.action("ack", r.tool, r.sessionId);
    li.appendChild(b);
  }
  return li;
}

// 宽度只用两档常量：实测宽度会随渲染时序抖动（滚动条/字体），导致右缘锚定时窗口横跳
const COLLAPSED_W = 92;
const EXPANDED_W = 340;

// 记住上次锚定方向：改窗口尺寸前先按它设好右对齐布局，
// 否则"窗口已变宽、右对齐类还没回来"的 IPC 空窗期灯珠会闪跳一帧
let lastSide: "left" | "right" = "left";

function applySide(side: "left" | "right"): void {
  lastSide = side;
  document.getElementById("widget")!.classList.toggle("anchor-right", side === "right");
}

function resizeTo(w: number, h: number): Promise<"left" | "right"> {
  applySide(lastSide);
  return tl.resize(w, h).then((side) => {
    applySide(side);
    return side;
  });
}

function syncSize(): void {
  const widget = document.getElementById("widget")!;
  // toast 显示期间保持 toast 档宽度，否则周期性状态推送会把窗口缩回去造成横跳
  const w = expanded ? EXPANDED_W : $("toast").hidden ? COLLAPSED_W : TOAST_W;
  const h = Math.min(700, Math.max(250, widget.scrollHeight + 10));
  void resizeTo(w, h);
}

/** 展开前按行数预估高度，先扩窗后渲染，避免右缘锚定下先渲染后扩窗产生的截断闪烁 */
function estimateHeight(rowCount: number): number {
  return Math.min(700, Math.max(250, 250 + 14 + Math.max(1, rowCount) * 30));
}

function render(p: StatePayload): void {
  last = p;
  // 展开中的过滤视图空了（会话结束/被清除）自动收起
  if (expanded && filter && filterRows(p.detail.rows, filter).length === 0) {
    expanded = false;
    filter = null;
  }
  const c = p.aggregate.counts;
  lamp("red", c.failed ?? 0, false);
  lamp("yellow", c.waiting ?? 0, p.breathing);
  lamp("green", c.running ?? 0, false);

  const degraded = $("degraded-dot");
  degraded.hidden = !p.dbDegraded;
  degraded.title = LABELS[p.lang].degraded;

  const panel = $("panel");
  panel.hidden = !expanded;
  if (expanded) {
    const rows = filter ? filterRows(p.detail.rows, filter) : p.detail.rows;
    const list = $("session-list");
    list.textContent = "";
    for (const r of rows) list.appendChild(makeRow(r, p.lang));
  }
  // 两段式同步：微任务先调一次，布局稳定后下一帧再校正一次，
  // 避免右缘锚定时首次展开量到偏小尺寸导致内容被截
  queueMicrotask(syncSize);
  requestAnimationFrame(() => requestAnimationFrame(syncSize));
}

function colorHasRows(color: "red" | "yellow" | "green"): boolean {
  if (!last) return false;
  return filterRows(last.detail.rows, color).length > 0;
}

// toast 窗宽固定：按鼠标坐标动态算宽会让右缘锚定的窗口随鼠标横跳，
// 且加宽时不切右对齐会导致灯珠左移→mouseleave→收窗→mouseenter 的抖动循环
const TOAST_W = 280;

let toastHideTimer: number | undefined;

function showToast(text: string, lampEl: HTMLElement): void {
  clearTimeout(toastHideTimer);
  const el = $("toast");
  el.classList.remove("wide");
  el.textContent = text;
  el.hidden = false;
  const place = (side: "left" | "right") => {
    const lr = lampEl.getBoundingClientRect();
    const tr = el.getBoundingClientRect();
    el.style.left = side === "right" ? `${Math.max(2, lr.left - tr.width - 10)}px` : `${lr.right + 10}px`;
    el.style.top = `${Math.max(2, lr.top + lr.height / 2 - tr.height / 2)}px`;
  };
  if (expanded) {
    // 面板已展开时窗口本来就够宽，原地放 toast，不动窗口
    place(lastSide);
    return;
  }
  void resizeTo(TOAST_W, 250).then(place);
}

/** 面板行内全名气泡：贴行下方（近底部翻到上方）展示可换行全名，不动窗口尺寸 */
function showNameToast(text: string, rowEl: HTMLElement): void {
  clearTimeout(toastHideTimer);
  const el = $("toast");
  el.textContent = text;
  el.classList.add("wide");
  el.hidden = false;
  const rr = rowEl.getBoundingClientRect();
  el.style.left = `${Math.max(2, rr.left + 4)}px`;
  el.style.top = "0px";
  const th = el.getBoundingClientRect().height;
  const below = rr.bottom + 4 + th <= window.innerHeight - 2;
  el.style.top = below ? `${rr.bottom + 4}px` : `${Math.max(2, rr.top - th - 4)}px`;
}

function hideToast(): void {
  // 延迟收窗：鼠标在相邻灯珠间移动时 leave/enter 连发，立即收会造成一缩一扩的横跳
  clearTimeout(toastHideTimer);
  toastHideTimer = window.setTimeout(() => {
    const el = $("toast");
    el.hidden = true;
    el.classList.remove("wide");
    syncSize();
  }, 250);
}

// 点击灯珠展开对应状态的会话明细；点同一颗收起；点另一颗切换过滤；
// 空状态灯珠不弹面板，悬停/点击用 toast 提示
for (const color of ["red", "yellow", "green"] as const) {
  const el = $(`lamp-${color}`);
  el.onclick = () => {
    if (!colorHasRows(color)) {
      showToast(LABELS[last?.lang ?? "zh"].empty, el);
      return;
    }
    clearTimeout(toastHideTimer);
    $("toast").hidden = true;
    if (expanded && filter === color) {
      // 收起：先撤面板重绘，再缩窗（缩窗不会截内容）
      expanded = false;
      filter = null;
      if (last) render(last);
    } else {
      // 展开：先扩窗到位（含右缘锚定与右对齐类切换），再渲染面板
      filter = color;
      const rows = last ? filterRows(last.detail.rows, color).length : 1;
      void resizeTo(EXPANDED_W, estimateHeight(rows)).then(() => {
        expanded = true;
        if (last) render(last);
      });
    }
  };
  el.onmouseenter = () => {
    if (!colorHasRows(color)) showToast(LABELS[last?.lang ?? "zh"].empty, el);
  };
  el.onmouseleave = hideToast;
}

tl.onState((p) => render(p as StatePayload));
tl.onPlaySound((file) => {
  void new Audio(`file://${file}`).play().catch(() => undefined);
});
