/*
 * Session Recorder panel logic.
 *
 * The panel is sandboxed: `window.pluginBridge.invoke(channel, payload)` is the
 * only way to reach the plugin process, which owns the archive. Nothing here
 * touches the filesystem or the network.
 *
 * Two rules hold everywhere in this file:
 *
 *   1. Conversation content is inserted with `textContent` / `createTextNode`,
 *      never as HTML, so archived tool output cannot inject markup.
 *   2. Payloads are decoded before they are shown. The host stores a tool
 *      result as an envelope like `{content:[{type:"text",text:"…"}]}`, and
 *      printing that envelope raw is what makes an archive unreadable — the
 *      readable text is unwrapped, and the untouched JSON stays one click away.
 */

(function () {
  "use strict";

  const bridge = window.pluginBridge;
  /** Long prose is clamped to this many lines until the reader expands it. */
  const BODY_CLAMP_LINES = 14;
  /** Payload text longer than this is cut in the panel only; the archive keeps it. */
  const PREVIEW_CHARS = 20000;
  /** How many nested `content[]` envelopes a single payload may unwrap. */
  const MAX_ENVELOPE_DEPTH = 3;

  const state = {
    archives: [],
    selected: null,
    query: "",
    busy: false,
    loading: false,
    detail: null,
    expanded: new Set(),
  };

  const byId = (id) => document.getElementById(id);
  const nodes = {
    readout: {
      sessions: byId("statSessions"),
      messages: byId("statMessages"),
      bytes: byId("statBytes"),
    },
    search: byId("search"),
    sync: byId("sync"),
    reload: byId("reload"),
    status: byId("status"),
    sessions: byId("sessions"),
    listCount: byId("listCount"),
    storage: byId("storage"),
    detail: byId("detail"),
    blank: byId("blank"),
    blankHint: byId("blankHint"),
    detailTitle: byId("detailTitle"),
    detailChips: byId("detailChips"),
    detailGaps: byId("detailGaps"),
    messages: byId("messages"),
    detailFooter: byId("detailFooter"),
    log: byId("log"),
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function show(node, visible) {
    if (visible) node.removeAttribute("hidden");
    else node.setAttribute("hidden", "");
  }

  function dash(value) {
    return value === null || value === undefined || value === "" ? "—" : String(value);
  }

  async function invoke(channel, payload) {
    if (!bridge || typeof bridge.invoke !== "function") {
      throw new Error("插件桥不可用（panel bridge unavailable）");
    }
    const reply = await bridge.invoke(channel, payload || {});
    if (reply && reply.ok === false) throw new Error(reply.error || "请求失败");
    return reply;
  }

  /* ------------------------------------------------------------ formatting */

  function parseDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function clockOf(date) {
    return date.toLocaleTimeString(undefined, { hour12: false });
  }

  function dayOf(date) {
    return date.toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" });
  }

  /** "09-28 14:04:31" the first time a day appears, "14:04:31" after that. */
  function timeLabel(value, previousDay) {
    const date = parseDate(value);
    if (!date) return value ? String(value) : "";
    const day = dayOf(date);
    return day === previousDay ? clockOf(date) : `${day} ${clockOf(date)}`;
  }

  function relativeLabel(value) {
    const date = parseDate(value);
    if (!date) return dash(value);
    const seconds = Math.round((Date.now() - date.getTime()) / 1000);
    if (seconds < 0) return "刚刚";
    if (seconds < 60) return `${seconds} 秒前`;
    if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`;
    if (seconds < 2592000) return `${Math.round(seconds / 86400)} 天前`;
    return date.toLocaleDateString();
  }

  function count(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString() : "—";
  }

  function pretty(value) {
    try {
      const text = JSON.stringify(value, null, 2);
      return text === undefined ? String(value) : text;
    } catch {
      return String(value);
    }
  }

  /** First non-empty string among the candidates, or null. */
  function firstText(...values) {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) return value;
    }
    return null;
  }

  /**
   * Re-close a JSON document that the recorder cut short.
   *
   * A long field is bounded by cutting the stored text and appending the
   * recorder's own `…[truncated N chars]` marker. Two cuts occur in practice:
   * inside a string, or part way through a token (`…"tags":{`). Parsing such a
   * field fails, and before this repair existed a reader saw the raw escaped
   * envelope instead of the output inside it.
   *
   * `closeDocument` covers the first case: it ends the string and closes every
   * open container, keeping the marker at the point where content was lost. The
   * second case needs the dangling tail dropped, so `repairTruncatedJson` tries
   * candidates from longest to progressively shorter and takes the first that
   * parses.
   *
   * @param {string} text document text to close
   * @param {string} marker truncation marker to keep, or ""
   * @returns {string|null} closed text, or null when there is nothing to close
   */
  function closeDocument(text, marker) {
    const open = [];
    let inString = false;
    let escaped = false;
    for (const character of text) {
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{" || character === "[") open.push(character);
      else if ((character === "}" || character === "]") && open.length) open.pop();
    }

    if (!inString && !open.length) return marker ? text : null;
    let closed = text;
    // A trailing backslash would escape the quote that closes the string.
    if (inString && escaped) closed = closed.slice(0, -1);
    if (inString) closed += `${marker.replace(/[\\"]/g, "\\$&")}"`;
    for (let index = open.length - 1; index >= 0; index -= 1) closed += open[index] === "{" ? "}" : "]";
    return closed;
  }

  /** How far back a repaired document may be trimmed. A marked cut may need a
   *  whole half-written token dropped; an unmarked one gets a smaller budget so
   *  a payload that cannot be repaired stays cheap to render. */
  const REPAIR_TAIL_CHARS = 512;
  const REPAIR_TAIL_CHARS_UNMARKED = 64;

  /**
   * @param {string} input candidate JSON text
   * @returns {string|null} repaired text, or null when the damage is not a cut
   *   this function can close.
   */
  function repairTruncatedJson(input) {
    const markerMatch = /(?:\r?\n)?…\[truncated \d+ chars\]\s*$/.exec(input);
    const marker = markerMatch ? markerMatch[0].replace(/^\r?\n/, "") : "";
    const body = markerMatch ? input.slice(0, markerMatch.index) : input;
    const extra = Math.min(marker ? REPAIR_TAIL_CHARS : REPAIR_TAIL_CHARS_UNMARKED, body.length);

    for (let drop = 0; drop <= extra; drop += 1) {
      const closed = closeDocument(drop ? body.slice(0, body.length - drop) : body, marker);
      if (closed === null) continue;
      try {
        JSON.parse(closed);
        return closed;
      } catch {
        // The cut left a half-written token: drop one more character and retry.
      }
    }
    return null;
  }

  /**
   * Parse JSON, tolerating a document that the size bound cut short.
   *
   * @returns {{ok: boolean, value: *}}
   */
  function parseJsonish(trimmed) {
    try {
      return { ok: true, value: JSON.parse(trimmed) };
    } catch {
      // Invalid as-is: it may be a stored field the recorder truncated.
    }
    const repaired = repairTruncatedJson(trimmed);
    if (repaired === null) return { ok: false, value: null };
    try {
      return { ok: true, value: JSON.parse(repaired) };
    } catch {
      return { ok: false, value: null };
    }
  }

  /**
   * If a string is JSON, show it indented; if that JSON carries text, show the
   * text instead. Three carriers occur in real transcripts:
   *
   *   1. command output — `stdout` (falling back to `stderr`, because a failed
   *      command's useful half is its error stream);
   *   2. a payload body — `text`/`output`, or `content` as a plain string
   *      (`Read` results keep the file text there);
   *   3. a nested result — `content` as a block array, i.e. the same envelope
   *      one level down, which is why this recurses.
   *
   * A non-zero `exitCode` travels with the text. Anything else is JSON.
   *
   * @param {string} input candidate text
   * @param {number} depth nesting guard for carrier 3
   * @returns {{text: string, wasJson: boolean, exitCode: number|null}}
   */
  function liftJson(input, depth = 0) {
    const text = typeof input === "string" ? input : String(input ?? "");
    const trimmed = text.trim();
    const looksJson = trimmed.length > 1 && (trimmed.startsWith("{") || trimmed.startsWith("["));
    if (!looksJson) return { text, wasJson: false, exitCode: null };
    const result = parseJsonish(trimmed);
    if (!result.ok) return { text, wasJson: false, exitCode: null };
    const parsed = result.value;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const exitCode = typeof parsed.exitCode === "number" ? parsed.exitCode : null;
      const body = firstText(parsed.stdout, parsed.output, parsed.text, parsed.content) ?? firstText(parsed.stderr);
      if (body) return { text: body.trimEnd(), wasJson: true, exitCode };

      const blocks = Array.isArray(parsed.content) ? parsed.content : null;
      const parts = [];
      for (const block of blocks ?? []) {
        if (typeof block === "string" && block) parts.push(block);
        else if (block && typeof block === "object" && typeof block.text === "string" && block.text) parts.push(block.text);
      }
      if (parts.length && depth < MAX_ENVELOPE_DEPTH) {
        const nested = liftJson(parts.join("\n"), depth + 1);
        return { text: nested.text, wasJson: true, exitCode: nested.exitCode ?? exitCode };
      }
      return { text: pretty(parsed), wasJson: true, exitCode };
    }
    return { text: pretty(parsed), wasJson: true, exitCode: null };
  }

  /** Attach the exit-code marker when a command did not succeed. */
  function withExitCode(text, exitCode) {
    if (typeof exitCode !== "number" || exitCode === 0) return text;
    return `${text}\n\n[退出码 ${exitCode}]`;
  }

  /**
   * Decode a host payload into readable text when it wraps prose.
   *
   * Known envelope: the runtime stores a tool result as
   * `{content:[{type:"text"/"tool_result", text:"…"}], details:{…}}`, and the
   * block's `text` is itself a JSON string for command tools. The exit code can
   * sit on the envelope, on its `details`, or inside that inner JSON, so all
   * three are consulted. Anything unrecognised is shown only as JSON.
   *
   * @returns {{text: string|null, raw: string, unchanged: boolean}}
   */
  function decodePayload(value) {
    const raw = pretty(value);
    if (value === null || value === undefined) return { text: null, raw, unchanged: true };
    if (typeof value === "string") {
      const lifted = liftJson(value);
      const text = withExitCode(lifted.text, lifted.exitCode);
      return { text, raw, unchanged: text === value };
    }

    if (typeof value === "object") {
      const parts = [];
      const blocks = Array.isArray(value.content) ? value.content : null;
      if (blocks) {
        for (const block of blocks) {
          if (!block || typeof block !== "object") continue;
          if (typeof block.text === "string" && block.text) parts.push(block.text);
          else if (typeof block.output === "string" && block.output) parts.push(block.output);
        }
      }
      if (!parts.length) {
        const direct = firstText(value.stdout, value.output, value.text, value.message, value.result, value.content);
        if (direct) parts.push(direct);
      }
      if (!parts.length) {
        const stream = firstText(value.stderr);
        if (stream) parts.push(stream);
      }

      if (parts.length) {
        const lifted = liftJson(parts.join("\n"));
        const envelopeExit = typeof value.exitCode === "number"
          ? value.exitCode
          : value.details && typeof value.details.exitCode === "number"
            ? value.details.exitCode
            : null;
        const text = withExitCode(lifted.text, lifted.exitCode ?? envelopeExit);
        return { text, raw, unchanged: text.trim() === raw.trim() };
      }
    }
    return { text: null, raw, unchanged: false };
  }

  /**
   * Readable text for any stored value, however it was wrapped.
   *
   * There are two shapes in the wild, and a tool row can carry either:
   *   1. an envelope object — `{content:[{type:"text",text:"…"}], details:{…}}`
   *      whose inner text is often JSON again;
   *   2. the *same envelope as a JSON string*, stored in a message's `content`.
   *
   * `decodePayload` covers shape 1; this wrapper peels a JSON string first, so a
   * tool body stops rendering as an escaped one-line blob.
   *
   * @returns {{text: string|null, raw: string, unchanged: boolean}}
   */
  function readableText(value) {
    const raw = pretty(value);
    let current = value;
    // A few rounds are enough for every observed shape; the bound also keeps a
    // pathological payload from looping.
    for (let round = 0; round < 3; round += 1) {
      if (typeof current === "string") {
        const trimmed = current.trim();
        const maybeJson = trimmed.length > 1 && (trimmed.startsWith("{") || trimmed.startsWith("["));
        if (maybeJson) {
          // A stored field can be JSON that the size bound cut short;
          // `parseJsonish` re-closes it, so such a row still reads as content.
          const result = parseJsonish(trimmed);
          if (result.ok) {
            current = result.value;
            continue;
          }
        }
        // Not JSON after all: it is ordinary text.
        return { text: current, raw, unchanged: current === raw };
      }
      if (current && typeof current === "object") {
        const decoded = decodePayload(current);
        if (decoded.text !== null && decoded.text.trim()) return { ...decoded, raw };
        return { text: null, raw, unchanged: false };
      }
      return { text: null, raw, unchanged: false };
    }
    return { text: null, raw, unchanged: false };
  }

  function clipped(text) {
    if (typeof text !== "string") return { text: "", clipped: false, length: 0 };
    if (text.length <= PREVIEW_CHARS) return { text, clipped: false, length: text.length };
    return {
      text: `${text.slice(0, PREVIEW_CHARS)}\n\n…[面板仅显示前 ${PREVIEW_CHARS} 字符；归档文件保留完整内容]`,
      clipped: true,
      length: text.length,
    };
  }

  /* ---------------------------------------------------------------- status */

  /** One status line, chosen by severity, never two competing messages. */
  function renderStatus(status) {
    const totals = status.totals || {};
    const incomplete = state.archives.filter((row) => row.incomplete);
    const problems = [];

    if (status.lastError) problems.push(`上次同步报告问题：${status.lastError}`);
    if (incomplete.length) {
      problems.push(`${incomplete.length} 个会话的本地归档不完整，已标记缺口（打开后可见原因）。`);
    }
    if (totals.overBudget) {
      problems.push(`归档已超出预算：${dash(totals.bytesLabel)} / ${dash(totals.budgetLabel)}。删除不再需要的会话即可回收。`);
    }

    if (problems.length) {
      nodes.status.dataset.level = "warn";
      nodes.status.textContent = problems.join(" ");
      show(nodes.status, true);
      return;
    }

    const last = status.lastResult;
    const bits = [];
    if (status.lastRunAt) bits.push(`上次同步：${relativeLabel(status.lastRunAt)}`);
    if (last) {
      const counts = [`新增 ${last.synced || 0}`, `跳过 ${last.skipped || 0}`];
      if (last.partial) counts.push(`部分 ${last.partial}`);
      if (last.failed) counts.push(`失败 ${last.failed}`);
      bits.push(counts.join(" · "));
    }
    if (state.archives.length === 0) {
      show(nodes.status, false);
      return;
    }
    nodes.status.dataset.level = "ok";
    nodes.status.textContent = bits.join(" · ") || "归档为最新";
    show(nodes.status, true);
  }

  /* ------------------------------------------------------------------ list */

  function renderReadout(status) {
    const totals = status.totals || {};
    nodes.readout.sessions.textContent = count(totals.sessions ?? state.archives.length);
    nodes.readout.messages.textContent = count(totals.messages);
    nodes.readout.bytes.textContent = dash(totals.bytesLabel);
    nodes.storage.textContent = `预算 ${dash(totals.budgetLabel)}`;
    nodes.log.textContent = (status.logTail || []).join("\n") || "（暂无日志）";
  }

  function matchingRows() {
    const needle = state.query.trim().toLowerCase();
    if (!needle) return state.archives;
    return state.archives.filter((row) => {
      const title = String(row.title || "").toLowerCase();
      const id = String(row.sessionId || "").toLowerCase();
      return title.includes(needle) || id.includes(needle);
    });
  }

  function renderList() {
    const rows = matchingRows();
    nodes.listCount.textContent = state.loading
      ? "读取中…"
      : `${count(rows.length)} / ${count(state.archives.length)} 个会话`;
    nodes.sessions.replaceChildren();

    if (state.loading) {
      const li = el("li");
      li.append(el("p", "rows__empty", "正在读取本地归档…"));
      nodes.sessions.append(li);
      return;
    }

    if (!rows.length) {
      const li = el("li");
      const message = state.archives.length
        ? "没有匹配的会话。清空筛选可看到全部。"
        : "还没有归档。点右上角「立即同步」抓取本机会话。";
      li.append(el("p", "rows__empty", message));
      nodes.sessions.append(li);
      return;
    }

    for (const row of rows) {
      const li = el("li", "rows__item");
      const button = el("button", "rows__btn");
      button.type = "button";
      button.setAttribute("aria-current", String(row.sessionId === state.selected));
      button.dataset.sessionId = row.sessionId;

      const title = el("span", "rows__title", dash(row.title || row.sessionId));
      const meta = el("div", "rows__meta");
      meta.append(el("span", null, `${count(row.storedMessages)} 条`));
      meta.append(el("span", null, "·"));
      const stamp = el("span", null, relativeLabel(row.updatedAt));
      stamp.title = dash(row.updatedAt);
      meta.append(stamp);
      if (row.bytesLabel) {
        meta.append(el("span", null, "·"));
        meta.append(el("span", null, row.bytesLabel));
      }
      if (row.incomplete) {
        const flag = el("span", "rows__flag", "不完整");
        flag.title = (row.problems || []).join("；") || "归档存在缺口";
        meta.append(flag);
      }

      button.append(title, meta);
      button.addEventListener("click", () => void select(row.sessionId));
      li.append(button);
      nodes.sessions.append(li);
    }
  }

  /** Arrow keys move between rows, the way a list in the host behaves. */
  function onListKeydown(event) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = [...nodes.sessions.querySelectorAll(".rows__btn")];
    const index = buttons.indexOf(document.activeElement);
    if (index === -1) return;
    const next = buttons[event.key === "ArrowDown" ? index + 1 : index - 1];
    if (!next) return;
    event.preventDefault();
    next.focus();
  }

  /* ---------------------------------------------------------------- detail */

  function chip(label, variant, title) {
    const node = el("span", variant ? `chip ${variant}` : "chip", label);
    if (title) node.title = title;
    return node;
  }

  function renderChips(header, stats, checkpoint) {
    nodes.detailChips.replaceChildren();
    if (header.modelId) nodes.detailChips.append(chip(header.modelId, "chip--mono", "本次会话使用的模型"));
    if (header.mode) nodes.detailChips.append(chip(header.mode, null, "会话模式"));
    nodes.detailChips.append(chip(`消息 ${count(stats.messages)}`, null, `用户 ${count(stats.userMessages)} / 助手 ${count(stats.assistantMessages)}`));
    nodes.detailChips.append(chip(`工具 ${count(stats.toolCalls)}`, null, stats.toolErrors ? `其中 ${count(stats.toolErrors)} 次失败` : "工具调用次数"));
    if (stats.toolErrors) nodes.detailChips.append(chip(`失败 ${count(stats.toolErrors)}`, "chip--warn"));
    if (checkpoint.redactions) {
      nodes.detailChips.append(chip(`已脱敏 ${count(checkpoint.redactions)}`, null, "落盘前掩码的密钥类字段数量"));
    }
    if ((checkpoint.truncatedFields || []).length) {
      nodes.detailChips.append(chip(`截断 ${checkpoint.truncatedFields.join(", ")}`, null, "超过字符上限而被截断的字段"));
    }
    if (checkpoint.incomplete) nodes.detailChips.append(chip("不完整", "chip--warn", (checkpoint.problems || []).join("；")));
  }

  function payloadBlock(label, value) {
    const wrap = el("div", "tool__block");
    const decoded = readableText(value);
    wrap.append(el("span", "tool__label", label));

    if (decoded.text !== null && (decoded.clipped || decoded.text.trim())) {
      const limited = clipped(decoded.text);
      wrap.append(el("pre", "tool__pre", limited.text));
    }

    // The readable form and the stored JSON differ → keep the exact bytes one
    // click away, because an archive is evidence and must not hide its source.
    const needsRaw = decoded.text === null || !decoded.unchanged;
    if (needsRaw) {
      const details = el("details", "tool__raw");
      details.append(el("summary", null, decoded.text === null ? "原始 JSON" : "原始 JSON（与上面解读可能不同）"));
      const limited = clipped(decoded.raw);
      details.append(el("pre", "tool__pre", limited.text));
      wrap.append(details);
    }
    return wrap;
  }

  /**
   * The body shown to the reader.
   *
   * `content` is usually prose, but a tool row can carry the same JSON envelope
   * as `toolResult` — printing that verbatim is what made an archive unreadable.
   * Anything that parses as JSON is lifted to its readable text first, and the
   * exact bytes stay reachable through the tool block's raw disclosure.
   */
  function messageBody(message) {
    if (!message.content) return null;
    // The body is decoded exactly like a tool result, because a tool row stores
    // the same envelope in `content` — sometimes as a JSON string.
    const decoded = readableText(message.content);
    const text = decoded.text === null ? String(message.content) : decoded.text;
    const isExpanded = state.expanded.has(message.id);
    const limited = clipped(text);
    const body = el("p", "msg__body", limited.text);

    // Only offer expansion when the text is actually long: a clamp on every
    // short message would add a control that does nothing. The threshold is
    // measured on the decoded text, not on the raw envelope's length.
    const collapsible = text.length > 900;
    if (collapsible && !isExpanded) {
      body.dataset.clamped = "true";
      return { body, toggle: true, collapsible };
    }
    return { body, toggle: false, collapsible };
  }

  function renderMessage(message, previousDay) {
    const li = el("li", `msg msg--${message.role || "unknown"}`);

    const head = el("div", "msg__head");
    head.append(el("span", "msg__role", message.role === "tool" ? "tool" : dash(message.role)));
    if (message.toolName) head.append(el("span", "msg__tool", message.toolName));
    if (message.agentName) head.append(chip(`子代理 ${message.agentName}`, null, "由哪个子代理产生"));
    const time = el("span", "msg__time", timeLabel(message.createdAt, previousDay));
    time.title = dash(message.createdAt);
    head.append(time);
    li.append(head);

    if (message.thinking) {
      const details = el("details", "tool__raw");
      details.append(el("summary", null, "思考过程"));
      details.append(el("pre", "tool__pre", clipped(message.thinking).text));
      li.append(details);
    }

    const body = messageBody(message);
    if (body) {
      li.append(body.body);
      if (body.toggle) {
        const toggle = el("button", "msg__toggle", "展开全文");
        toggle.type = "button";
        toggle.addEventListener("click", () => {
          state.expanded.add(message.id);
          renderDetail();
        });
        li.append(toggle);
      } else if (body.collapsible && state.expanded.has(message.id)) {
        const toggle = el("button", "msg__toggle", "收起");
        toggle.type = "button";
        toggle.addEventListener("click", () => {
          state.expanded.delete(message.id);
          renderDetail();
        });
        li.append(toggle);
      }
    }

    const toolBlock = el("div", "tool");
    const hasTool = message.toolName || message.toolArgs !== undefined || message.toolResult !== undefined || message.error !== undefined;
    if (hasTool) {
      if (message.toolName || message.toolStatus || message.toolDurationMs) {
        const bar = el("div", "tool__head");
        if (message.toolStatus) {
          const status = el("span", "tool__status", message.toolStatus);
          status.dataset.status = String(message.toolStatus);
          bar.append(status);
        }
        if (message.toolDurationMs) bar.append(el("span", null, `${count(message.toolDurationMs)} ms`));
        if (message.parentToolCallId) bar.append(el("span", null, "子调用"));
        if (message.toolPayloadsOmitted) bar.append(el("span", null, "参数与结果未记录（设置已关闭）"));
        if (bar.childNodes.length) toolBlock.append(bar);
      }
      if (message.toolArgs !== undefined) toolBlock.append(payloadBlock("参数", message.toolArgs));
      if (message.toolResult !== undefined) toolBlock.append(payloadBlock("结果", message.toolResult));
      if (message.error !== undefined) toolBlock.append(payloadBlock("错误", message.error));
      if (toolBlock.childNodes.length) li.append(toolBlock);
    }

    return li;
  }

  function renderDetail() {
    const payload = state.detail;
    if (!payload) return;
    const { header = {}, stats = {}, checkpoint = {}, messages = [], gaps = [] } = payload;

    show(nodes.blank, false);
    show(nodes.detail, true);

    nodes.detailTitle.textContent = dash(header.title || header.id || payload.sessionId);
    renderChips(header, stats, checkpoint);

    const reasons = [...new Set([...(checkpoint.problems || []), ...gaps.map((gap) => gap.reason)])];
    if (reasons.length) {
      nodes.detailGaps.textContent = `该会话的本地归档不完整：${reasons.join("；")}。缺口之外的内容仍可正常查看与导出。`;
      show(nodes.detailGaps, true);
    } else {
      show(nodes.detailGaps, false);
    }

    nodes.messages.replaceChildren();
    let previousDay = null;
    for (const message of messages) {
      const date = parseDate(message.createdAt);
      const day = date ? dayOf(date) : null;
      nodes.messages.append(renderMessage(message, previousDay));
      if (day) previousDay = day;
    }

    const parts = [];
    if (checkpoint.storedMessages !== undefined) parts.push(`归档 ${count(checkpoint.storedMessages)} 条`);
    if (checkpoint.lastSyncAt) parts.push(`上次同步 ${relativeLabel(checkpoint.lastSyncAt)}`);
    if (checkpoint.lastSyncMode) parts.push(`模式 ${checkpoint.lastSyncMode}`);
    if (stats.firstAt) parts.push(`最早 ${stats.firstAt}`);
    if (stats.lastAt) parts.push(`最新 ${stats.lastAt}`);
    nodes.detailFooter.textContent = parts.join(" · ");
  }

  /* --------------------------------------------------------------- actions */

  async function refresh(preferredSessionId) {
    state.loading = true;
    nodes.sessions.setAttribute("aria-busy", "true");
    renderList();
    try {
      const reply = await invoke("recorder.list");
      state.archives = reply.archives || [];
      renderReadout(reply.status || {});
      const target = preferredSessionId || state.selected;
      const stillExists = target && state.archives.some((row) => row.sessionId === target);
      state.loading = false;
      nodes.sessions.removeAttribute("aria-busy");
      renderList();
      renderStatus(reply.status || {});
      if (stillExists) await select(target, { keepList: true });
      else if (target) {
        state.selected = null;
        state.detail = null;
        show(nodes.detail, false);
        show(nodes.blank, true);
      }
      const info = reply.status && reply.status.storage;
      nodes.blankHint.textContent = info ? `归档位置：${info.sessions}` : "";
    } catch (error) {
      state.loading = false;
      nodes.sessions.removeAttribute("aria-busy");
      renderList();
      setStatus(`读取归档失败：${error.message}`, "warn");
    }
  }

  function setStatus(message, level) {
    nodes.status.dataset.level = level || "ok";
    nodes.status.textContent = message;
    show(nodes.status, true);
  }

  async function select(sessionId, options = {}) {
    state.selected = sessionId;
    state.expanded.clear();
    renderList();
    try {
      const payload = await invoke("recorder.get", { sessionId, limit: 800 });
      state.detail = payload;
      renderDetail();
    } catch (error) {
      setStatus(`读取该会话归档失败：${error.message}`, "warn");
    }
    if (!options.keepList) nodes.sessions.scrollIntoView({ block: "nearest" });
  }

  async function runSync() {
    if (state.busy) return;
    state.busy = true;
    nodes.sync.disabled = true;
    nodes.reload.disabled = true;
    nodes.sync.setAttribute("aria-busy", "true");
    nodes.sync.textContent = "同步中…";
    try {
      const reply = await invoke("recorder.sync", {});
      await refresh(state.selected);
      const result = reply.result || {};
      const level = result.failed || result.partial ? "warn" : "ok";
      const parts = [`新增 ${result.synced || 0}`, `跳过 ${result.skipped || 0}`];
      if (result.partial) parts.push(`部分 ${result.partial}`);
      if (result.failed) parts.push(`失败 ${result.failed}`);
      if (result.listed !== undefined) parts.unshift(`扫描 ${result.listed} 个会话`);
      setStatus(`同步完成：${parts.join(" · ")}`, level);
    } catch (error) {
      setStatus(`同步失败：${error.message}`, "warn");
    } finally {
      state.busy = false;
      nodes.sync.disabled = false;
      nodes.reload.disabled = false;
      nodes.sync.removeAttribute("aria-busy");
      nodes.sync.textContent = "立即同步";
    }
  }

  async function runExport(format, button) {
    if (!state.selected) return;
    button.disabled = true;
    try {
      const reply = await invoke("recorder.export", { sessionId: state.selected, format });
      const files = Object.values(reply.files || {});
      setStatus(files.length ? `已导出：${files.join(" · ")}` : "没有可导出的内容。", files.length ? "ok" : "warn");
      if (reply.status) {
        state.archives = (await invoke("recorder.list")).archives || state.archives;
        renderReadout(reply.status);
        renderList();
      }
    } catch (error) {
      setStatus(`导出失败：${error.message}`, "warn");
    } finally {
      button.disabled = false;
    }
  }

  async function runDelete() {
    if (!state.selected) return;
    const row = state.archives.find((entry) => entry.sessionId === state.selected);
    const label = row && row.title ? `「${row.title}」` : "该会话";
    if (!window.confirm(`删除${label}的本地归档？宿主中的原始会话不受影响，但这份归档不可恢复。`)) return;
    try {
      await invoke("recorder.delete", { sessionId: state.selected });
      state.selected = null;
      state.detail = null;
      show(nodes.detail, false);
      show(nodes.blank, true);
      await refresh();
      setStatus("已删除本地归档。", "ok");
    } catch (error) {
      setStatus(`删除失败：${error.message}`, "warn");
    }
  }

  function wire() {
    nodes.search.addEventListener("input", () => {
      state.query = nodes.search.value;
      renderList();
    });
    nodes.search.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && nodes.search.value) {
        nodes.search.value = "";
        state.query = "";
        renderList();
      }
    });
    nodes.sessions.addEventListener("keydown", onListKeydown);
    nodes.sync.addEventListener("click", () => void runSync());
    nodes.reload.addEventListener("click", () => {
      void refresh(state.selected).then(() => setStatus("已刷新。", "ok"));
    });
    byId("exportMd").addEventListener("click", (event) => void runExport("md", event.currentTarget));
    byId("exportJsonl").addEventListener("click", (event) => void runExport("jsonl", event.currentTarget));
    byId("exportBoth").addEventListener("click", (event) => void runExport("both", event.currentTarget));
    byId("delete").addEventListener("click", () => void runDelete());

    if (bridge && typeof bridge.on === "function") {
      bridge.on("recorder:changed", () => {
        void refresh(state.selected).catch(() => {});
      });
    }
  }

  wire();
  void refresh();
})();
