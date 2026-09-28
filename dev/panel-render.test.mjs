import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createDom, idsFromMarkup } from "./dom-stub.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..", "plugin");
const markupPath = path.join(pluginRoot, "renderer", "index.html");
const panelPath = path.join(pluginRoot, "renderer", "panel.js");
const fixturePath = path.join(here, "panel-preview-fixture.js");
const cssPath = path.join(pluginRoot, "renderer", "panel.css");

const markup = readFileSync(markupPath, "utf8");
const panelSource = readFileSync(panelPath, "utf8");
const css = readFileSync(cssPath, "utf8");

/**
 * Wait for real time: the fixture answers through `setTimeout`, and a
 * `setImmediate` drain loop can finish in under a millisecond and starve it.
 */
async function settle(rounds = 12, stepMs = 12) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, stepMs));
}

/** Boot the real panel.js in a shimmed DOM with the preview fixture's bridge. */
async function bootPanel() {
  const { window, document, elements } = createDom(markupPath);
  const sandbox = {
    window,
    document,
    console,
    setTimeout,
    clearTimeout,
    JSON,
    Date,
    Math,
    Number,
    String,
    Object,
    Array,
    Set,
    Map,
    Promise,
    Infinity,
    NaN,
    isNaN,
    parseFloat,
    parseInt,
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(readFileSync(fixturePath, "utf8"), context, { filename: "panel-preview-fixture.js" });
  vm.runInContext(panelSource, context, { filename: "panel.js" });
  await settle();
  return { window, document, elements, context };
}

const textOf = (node) => (node ? node.allText : "");

// ------------------------------------------------------------ id contract

test("every id panel.js looks up exists in renderer/index.html", () => {
  const defined = new Set(idsFromMarkup(markup));
  const referenced = new Set();
  for (const match of panelSource.matchAll(/byId\("([^"]+)"\)/g)) referenced.add(match[1]);
  const missing = [...referenced].filter((id) => !defined.has(id));
  assert.deepEqual(missing, [], `panel.js references undefined ids: ${missing.join(", ")}`);
  assert.ok(referenced.size >= 12, `expected a real element set, saw ${referenced.size}`);
});

test("every class panel.js builds has a rule in panel.css", () => {
  const built = new Set();
  for (const match of panelSource.matchAll(/el\("[a-z]+", "([a-z0-9_ -]+)"/gi)) {
    for (const token of match[1].split(/\s+/)) if (token) built.add(token);
  }
  for (const match of panelSource.matchAll(/`msg msg--\$\{[^}]+\}`/g)) built.add("msg");
  for (const match of panelSource.matchAll(/`chip \$\{[^}]*\}`/g)) built.add("chip");
  const styled = new Set();
  for (const match of css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)) styled.add(match[1]);
  const unstyled = [...built].filter((name) => !styled.has(name));
  assert.deepEqual(unstyled, [], `panel.js builds unstyled classes: ${unstyled.join(", ")}`);
});

test("the panel declares the host chrome contract and uses host tokens", () => {
  assert.match(markup, /<meta name="pi-plugin-chrome" content="v2"\s*\/?>/);
  assert.match(css, /--pi-plugin-titlebar-height/);
  assert.match(css, /var\(--ds-text-primary/);
  assert.match(css, /var\(--ds-border/);
  assert.match(css, /prefers-reduced-motion/);
});

// ------------------------------------------------------------ render path

test("the panel renders the archive list from the bridge", async () => {
  const { elements } = await bootPanel();
  const rows = elements.get("sessions").querySelectorAll(".rows__btn");
  assert.equal(rows.length, 3, "three archived sessions");
  assert.match(textOf(elements.get("sessions")), /不完整/, "the gapped session is flagged");
  assert.equal(elements.get("statSessions").textContent, "3");
  assert.equal(elements.get("statBytes").textContent, "2.3 MB");
  assert.match(elements.get("storage").textContent, /512 MB/);
  assert.equal(elements.get("status").getAttribute("data-level"), "warn");
  assert.match(elements.get("status").textContent, /1 个会话的本地归档不完整/);
});

test("selecting a session renders decoded tool output instead of raw JSON", async () => {
  const { elements } = await bootPanel();
  elements.get("sessions").querySelectorAll(".rows__btn")[0].click();
  await settle();

  const messages = elements.get("messages");
  const rendered = textOf(messages);
  assert.ok(messages.querySelectorAll(".msg").length >= 9, "the whole transcript renders");

  /** Text a reader sees without opening a disclosure. */
  const isInsideRaw = (node) => {
    let current = node.parentNode;
    while (current) {
      if (current.tagName === "DETAILS" && current.classList.contains("tool__raw")) return true;
      current = current.parentNode;
    }
    return false;
  };
  const primary = [
    ...messages.querySelectorAll(".msg__body").map((node) => node.allText),
    ...messages
      .querySelectorAll(".tool__pre")
      .filter((node) => !isInsideRaw(node))
      .map((node) => node.allText),
  ].join("\n");

  // The readable command output is what the reader sees without clicking...
  assert.match(primary, /gitee\.com\/hatricks\/public_utils/, "decoded stdout is the primary rendering");
  assert.ok(!primary.includes('\\"stdout\\"'), "the escaped envelope must not be the primary rendering");
  // ...and the full command output, line by line, rather than a single escaped blob.
  assert.match(primary, /origin\s+https:\/\/gitee\.com\/hatricks\/public_utils\.git \(push\)/, "each output line is readable");
  assert.match(primary, /\[退出码 128\]/, "a failed command reports its exit code next to its error text");

  // The exact stored bytes stay available, one disclosure away, so an archive
  // never hides its own source.
  const rawText = messages
    .querySelectorAll(".tool__pre")
    .filter((node) => isInsideRaw(node))
    .map((node) => node.allText)
    .join("\n");
  assert.match(rawText, /\\"stdout\\"|"stdout"/, "the stored envelope is still reachable");
  const summaries = messages
    .descendants()
    .filter((node) => node.tagName === "SUMMARY")
    .map((node) => node.textContent);
  assert.ok(summaries.some((text) => text.includes("原始 JSON")), `expected a raw disclosure, saw: ${summaries.join(" | ")}`);

  const statuses = messages.descendants().filter((node) => node.classList.contains("tool__status"));
  assert.ok(statuses.some((node) => node.dataset.status === "success"), "a successful tool call is labelled");
  assert.ok(statuses.some((node) => node.dataset.status === "error"), "the failed call is labelled");
});

test("the detail header uses chips and bounded actions", async () => {
  const { elements } = await bootPanel();
  elements.get("sessions").querySelectorAll(".rows__btn")[0].click();
  await settle();

  const chips = elements.get("detailChips").querySelectorAll(".chip").map((node) => node.textContent);
  assert.ok(chips.some((text) => text.includes("deepseek-flash")), `model chip missing: ${chips.join(" | ")}`);
  assert.ok(chips.some((text) => text.includes("工具")), "tool count chip missing");
  assert.ok(chips.some((text) => text.includes("已脱敏")), "redaction chip missing");
  assert.ok(chips.some((text) => text.includes("截断")), "truncation chip missing");
  assert.equal(elements.get("detail").hasAttribute("hidden"), false);
  assert.equal(elements.get("blank").hasAttribute("hidden"), true);
  assert.match(elements.get("detailFooter").textContent, /归档 240 条/);
});

test("long prose is clamped with an explicit expand control", async () => {
  const { elements } = await bootPanel();
  elements.get("sessions").querySelectorAll(".rows__btn")[0].click();
  await settle();

  const clamped = elements.get("messages").querySelectorAll(".msg__body").find((node) => node.dataset.clamped === "true");
  assert.ok(clamped, "the long answer must be clamped, not dumped");
  const toggles = elements.get("messages").descendants().filter((node) => node.classList.contains("msg__toggle"));
  assert.ok(toggles.length >= 1, "a clamp without an expand control traps content");

  toggles[0].click();
  await settle();
  const stillClamped = elements.get("messages").querySelectorAll(".msg__body").find((node) => node.dataset.clamped === "true");
  assert.equal(stillClamped, undefined, "expanding removes the clamp");
});

// ------------------------------------------------------------- list filter

test("filtering narrows the list by title or session id", async () => {
  const { elements } = await bootPanel();
  const search = elements.get("search");

  search.value = "kafka";
  search.dispatch("input");
  assert.equal(elements.get("sessions").querySelectorAll(".rows__btn").length, 1);
  assert.match(textOf(elements.get("sessions")), /排查 Kafka 消费延迟/);
  assert.match(elements.get("listCount").textContent, /1 \/ 3/);

  search.value = "77aa33bb";
  search.dispatch("input");
  assert.equal(elements.get("sessions").querySelectorAll(".rows__btn").length, 1, "id matching works");

  search.value = "zzzz";
  search.dispatch("input");
  assert.match(textOf(elements.get("sessions")), /没有匹配的会话/);
});

test("a tool row whose content is the envelope is decoded too, not dumped", async () => {
  const { elements } = await bootPanel();
  elements.get("sessions").querySelectorAll(".rows__btn")[0].click();
  await settle();

  const messages = elements.get("messages");
  // Locate by content rather than position: the point is that THIS row decodes.
  const toolRow = messages
    .querySelectorAll(".msg")
    .find((node) => node.classList.contains("msg--tool") && node.allText.includes("mcp-control"));
  assert.ok(toolRow, "the envelope-in-content tool row rendered at all");
  const body = toolRow.querySelectorAll(".msg__body")[0];
  assert.ok(body, "the tool row has a body");
  const text = body.allText;

  assert.match(text, /mcp-control\.ts:209/, "the ripgrep output is the body, not an escaped blob");
  assert.match(text, /remote-backend\.ts:121/, "every output line survives decoding");
  assert.ok(!text.includes('\\"stdout\\"'), "the escaped envelope must not reach the body");
  assert.ok(!text.startsWith('{"content"'), "the body must not start with the raw envelope");

  const summaries = messages
    .descendants()
    .filter((node) => node.tagName === "SUMMARY")
    .map((node) => node.textContent);
  assert.ok(
    summaries.some((label) => label.includes("原始 JSON")),
    `expected a raw disclosure, saw: ${summaries.join(" | ")}`,
  );
});

test("a tool row cut by the size bound decodes, and shows where it was cut", async () => {
  const { elements } = await bootPanel();
  elements.get("sessions").querySelectorAll(".rows__btn")[0].click();
  await settle();

  const messages = elements.get("messages");
  const toolRow = messages
    .querySelectorAll(".msg")
    .find((node) => node.classList.contains("msg--tool") && node.allText.includes("catalog-report"));
  assert.ok(toolRow, "the truncated tool row rendered at all");
  const body = toolRow.querySelectorAll(".msg__body")[0];
  assert.ok(body, "the truncated tool row has a body");
  const text = body.allText;

  assert.match(text, /line 0 of catalog output/, "the cut envelope is decoded, not dumped");
  assert.ok(text.split("of catalog output").length >= 5, "several output lines survive the cut");
  assert.match(text, /…\[truncated \d+ chars\]/, "the body shows where the recorder cut the field");
  assert.ok(!text.includes('\\"stdout\\"'), "the escaped envelope must not reach the body");
  assert.ok(!text.startsWith('{"content"'), "the body must not start with the raw envelope");
  assert.match(toolRow.allText, /catalog-report\.mjs/, "the stored command is still reachable");

test("every stored wrapping still reads as content, including a mid-token cut", async () => {
  const { elements } = await bootPanel();
  elements.get("sessions").querySelectorAll(".rows__btn")[0].click();
  await settle();

  const messages = elements.get("messages");
  const bodyOf = (needle) => {
    const row = messages
      .querySelectorAll(".msg")
      .find((node) => node.classList.contains("msg--tool") && node.allText.includes(needle));
    assert.ok(row, `the tool row containing ${needle} rendered`);
    const body = row.querySelectorAll(".msg__body")[0];
    assert.ok(body, `the tool row containing ${needle} has a body`);
    return body.allText;
  };

  // A payload body kept in `content` as a plain string (`Read` results).
  const readBody = bodyOf("archive-store.js");
  assert.match(readBody, /195:    const row = index\.sessions\[sessionId\];/, "the read payload body is the file text");
  assert.ok(!/^\s*\{/.test(readBody), "the wrapper must not become the body");

  // The envelope shape again, one level down.
  const nestedBody = bodyOf("preview.html");
  assert.match(nestedBody, /## Pages/, "the nested result text is the body");
  assert.ok(!nestedBody.includes('"type": "text"'), "the nested envelope must not be dumped");
  assert.ok(!nestedBody.trim().startsWith("{"), "the nested envelope must not be the body");

  // A cut that lands part way through a token, so the tail has to be dropped.
  const grepBody = bodyOf("stderr.write");
  assert.match(grepBody, /first match/, "a mid-token cut still decodes its matches");
  assert.match(grepBody, /second match/, "every recovered match survives");
  assert.match(grepBody, /…\[truncated \d+ chars\]|"count": 2/, "the recovered payload keeps its shape");
  assert.ok(!grepBody.trim().startsWith('{"content"'), "the raw envelope must not be the body");
});
});
