import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const core = require("../plugin/lib/recorder-core.js");
const { createArchiveStore } = require("../plugin/lib/archive-store.js");

// ---------------------------------------------------------------- redaction

test("isSecretKey matches secret-shaped keys and leaves ordinary ones alone", () => {
  for (const key of ["apiKey", "api_key", "accessToken", "Authorization", "cookie", "clientSecret", "private-key", "password", "refresh_token"]) {
    assert.equal(core.isSecretKey(key), true, `${key} should be treated as secret`);
  }
  for (const key of ["keys", "keyboard", "monkey", "massKey", "authorizedBy", "signatureVersion", "tokens", "maxTokens"]) {
    assert.equal(core.isSecretKey(key), false, `${key} should not be treated as secret`);
  }
  // Documented conservative false positive: a fragment match inside a longer
  // name wins over precision, because a leaked credential costs more than a
  // masked counter.
  assert.equal(core.isSecretKey("cookiejarSize"), true);
});

test("redactText masks bearer tokens, JWTs, vendor keys and query parameters", () => {
  const input = [
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
    "key=sk-live-abcdefghijklmnopqrstuvwx",
    "https://x.test/cb?access_token=supersecretvalue&next=1",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    "mongodb://user:hunter2@db.internal/app",
  ].join("\n");
  const { text, count } = core.redactText(input);
  assert.ok(count >= 5, `expected several redactions, got ${count}`);
  assert.ok(!text.includes("abcdefghijklmnopqrstuvwxyz123456"));
  assert.ok(!text.includes("supersecretvalue"));
  assert.ok(!text.includes("hunter2"));
  assert.ok(!text.includes("dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"));
  assert.ok(text.includes("access_token=[redacted]"), "keeps the parameter name for readability");
});

// ---------------------------------------------------------- normalization

function hostMessage(overrides = {}) {
  return {
    id: "m1",
    role: "assistant",
    content: "hello",
    createdAt: "2026-09-28T10:00:00.000Z",
    ...overrides,
  };
}

test("normalizeMessage bounds long content and records the original length", () => {
  const long = "x".repeat(500);
  const { record, state } = core.normalizeMessage(hostMessage({ content: long }), { maxContentChars: 100 });
  assert.equal(state.truncations.content, 500);
  assert.ok(record.content.startsWith("x".repeat(100)));
  assert.ok(record.content.includes("truncated 400 chars"));
});

test("normalizeMessage redacts secret keys inside tool arguments", () => {
  const { record, state } = core.normalizeMessage(
    hostMessage({
      toolName: "Bash",
      toolArgs: { command: "curl -H \"Authorization: Bearer abcdefghijklmnopqrstuvwxyz\"", apiKey: "sk-live-abcdefghijklmnop" },
      toolResult: { stdout: "ok", headers: { cookie: "session=abc" } },
    }),
    { redactSecrets: true },
  );
  assert.equal(record.toolArgs.apiKey, core.REDACTED);
  assert.equal(record.toolResult.headers.cookie, core.REDACTED);
  assert.ok(state.redactions >= 2);
  assert.ok(!JSON.stringify(record).includes("sk-live-abcdefghijklmnop"));
});

test("normalizeMessage omits tool payloads when the setting is off", () => {
  const { record } = core.normalizeMessage(
    hostMessage({ toolName: "Read", toolArgs: { path: "a.ts" }, toolResult: { text: "secret" } }),
    { includeToolPayloads: false },
  );
  assert.equal(record.toolArgs, undefined);
  assert.equal(record.toolResult, undefined);
  assert.equal(record.toolPayloadsOmitted, true);
  assert.equal(record.toolName, "Read");
});

test("normalizeMessage keeps usage, durations and subagent provenance", () => {
  const { record } = core.normalizeMessage(
    hostMessage({
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      responseDurationMs: 1234,
      toolDurationMs: 55,
      parentToolCallId: "call_1",
      agentName: "explorer",
      modelId: "claude-sonnet-4",
      attachments: [{ name: "a.png", mimeType: "image/png", size: 1234, dataUrl: "data:image/png;base64,AAAA" }],
    }),
  );
  assert.deepEqual(record.usage, {
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    totalTokens: 30,
  });
  assert.equal(record.responseDurationMs, 1234);
  assert.equal(record.toolDurationMs, 55);
  assert.equal(record.parentToolCallId, "call_1");
  assert.equal(record.agentName, "explorer");
  assert.equal(record.attachments[0].name, "a.png");
  assert.ok(!("dataUrl" in record.attachments[0]), "attachment bytes must never be archived");
});

test("normalizeMessage rejects a record without an id", () => {
  assert.equal(core.normalizeMessage({ role: "user", content: "x" }).record, null);
  assert.equal(core.normalizeMessage(null).record, null);
});

test("extractSessionList reads the host reply shape", () => {
  const list = core.extractSessionList({
    sessions: [{ id: "s1", title: "T", messageCount: 4, updatedAt: "2026-09-28T10:00:00.000Z" }],
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].messageCount, 4);
  assert.deepEqual(core.extractSessionList({}), []);
});

test("extractSessionDetail unwraps the session envelope and exposes the window", () => {
  const detail = core.extractSessionDetail({
    session: {
      id: "s1",
      title: "T",
      messageCount: 3,
      messages: [{ id: "m1", role: "user", content: "hi", createdAt: "2026-09-28T10:00:00.000Z" }],
      messageStart: 0,
      messageEnd: 3,
      hasMoreBefore: false,
      hasMoreAfter: false,
    },
  });
  assert.equal(detail.messages.length, 1);
  assert.equal(detail.messageStart, 0);
  assert.equal(detail.hasMoreBefore, false);
  assert.equal(detail.summary.id, "s1");
});

// ------------------------------------------------------------- sync policy

test("planSync chooses full, incremental or skip", () => {
  const summary = { id: "s1", messageCount: 10, updatedAt: "2026-09-28T10:00:00.000Z" };
  assert.deepEqual(core.planSync(summary, null).mode, "full");
  assert.deepEqual(core.planSync(summary, { sessionId: "s1", storedMessages: 4, updatedAt: summary.updatedAt }).mode, "incremental");
  assert.deepEqual(core.planSync(summary, { sessionId: "s1", storedMessages: 10, updatedAt: summary.updatedAt }).mode, "skip");
  assert.deepEqual(core.planSync(summary, { sessionId: "s1", storedMessages: 12, updatedAt: summary.updatedAt }).mode, "full");
  assert.deepEqual(
    core.planSync(summary, { sessionId: "s1", storedMessages: 10, updatedAt: "2026-09-27T10:00:00.000Z" }).mode,
    "incremental",
  );
  assert.deepEqual(core.planSync(summary, { sessionId: "other", storedMessages: 10, updatedAt: summary.updatedAt }).mode, "full");
});

test("nextWindowRequest omits the cursor on the first page and respects the cap", () => {
  assert.deepEqual(core.nextWindowRequest("s1", undefined, 200, 0, 1000), { id: "s1", messageLimit: 200 });
  assert.deepEqual(core.nextWindowRequest("s1", 500, 200, 0, 1000), { id: "s1", messageLimit: 200, messageBefore: 500 });
  assert.deepEqual(core.nextWindowRequest("s1", undefined, 200, 900, 1000), { id: "s1", messageLimit: 100 });
  assert.equal(core.nextWindowRequest("s1", undefined, 200, 1000, 1000), null);
  assert.deepEqual(core.nextWindowRequest("s1", undefined, 9999, 0, 1000).messageLimit, 500);
});

test("mergeMessages dedupes by id keep-last and orders ascending", () => {
  const existing = [
    { id: "b", role: "user", createdAt: "2026-09-28T10:00:02.000Z", content: "old" },
    { id: "a", role: "user", createdAt: "2026-09-28T10:00:01.000Z", content: "first" },
  ];
  const incoming = [
    { id: "b", role: "user", createdAt: "2026-09-28T10:00:02.000Z", content: "new" },
    { id: "c", role: "assistant", createdAt: "2026-09-28T10:00:03.000Z", content: "third" },
  ];
  const merged = core.mergeMessages(existing, incoming, { maxMessagesPerSession: 100 });
  assert.deepEqual(merged.messages.map((m) => m.id), ["a", "b", "c"]);
  assert.equal(merged.messages.find((m) => m.id === "b").content, "new");
});

test("mergeMessages drops the oldest records at the cap", () => {
  const existing = Array.from({ length: 5 }, (_, i) => ({
    id: `m${i}`,
    role: "user",
    createdAt: `2026-09-28T10:00:0${i}.000Z`,
    content: String(i),
  }));
  const merged = core.mergeMessages(existing, [], { maxMessagesPerSession: 3 });
  assert.equal(merged.messages.length, 3);
  assert.equal(merged.dropped, 2);
  assert.deepEqual(merged.messages.map((m) => m.id), ["m2", "m3", "m4"]);
});

// ------------------------------------------------------------ agent-facing

test("searchArchive reports bounded excerpts and honours the limit", () => {
  const sessions = [
    {
      summary: { id: "s1", title: "Deploy notes", updatedAt: "2026-09-28T10:00:00.000Z" },
      messages: [
        { id: "m1", role: "user", content: "how do I rotate the NEXUS token please", createdAt: "t1" },
        { id: "m2", role: "assistant", content: "unrelated", createdAt: "t2" },
      ],
    },
    { summary: { id: "s2", title: "Other" }, messages: [{ id: "m3", role: "user", content: "nothing here", createdAt: "t3" }] },
  ];
  const hits = core.searchArchive(sessions, "nexus", { excerptChars: 40, limit: 10 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionId, "s1");
  assert.ok(hits[0].matches[0].excerpt.length <= 41);
  const limited = core.searchArchive(sessions, "", { limit: 1 });
  assert.equal(limited.length, 1);
});

test("summarizeArchive counts messages, tools, redactions and gaps", () => {
  const stats = core.summarizeArchive([
    { type: "message", role: "user", content: "a", createdAt: "2026-09-28T10:00:00.000Z" },
    { type: "message", role: "assistant", content: "b", createdAt: "2026-09-28T10:00:01.000Z", toolName: "Bash", isError: true, redactions: 2, truncations: { content: 900 } },
    { type: "gap", reason: "fetch-error" },
  ]);
  assert.equal(stats.messages, 2);
  assert.equal(stats.userMessages, 1);
  assert.equal(stats.toolCalls, 1);
  assert.equal(stats.toolErrors, 1);
  assert.equal(stats.redactions, 2);
  assert.equal(stats.gaps, 1);
  assert.deepEqual(stats.truncatedFields, ["content"]);
  assert.equal(stats.firstAt, "2026-09-28T10:00:00.000Z");
  assert.equal(stats.lastAt, "2026-09-28T10:00:01.000Z");
});

test("safeFileName keeps ids path-safe", () => {
  assert.equal(core.safeFileName("../../etc/passwd"), ".._.._etc_passwd".replace(/^[._]+/, ""));
  assert.ok(!core.safeFileName("a/b\\c:d").includes("/"));
  assert.ok(!core.safeFileName("a/b\\c:d").includes("\\"));
  assert.equal(core.safeFileName(""), "session");
});

test("toJsonl emits one JSON object per line and toMarkdown renders tool context", () => {
  const jsonl = core.toJsonl([{ type: "message", id: "m1" }, { type: "gap", reason: "x" }]);
  assert.equal(jsonl.trim().split("\n").length, 2);
  const md = core.toMarkdown({
    summary: { id: "s1", title: "T", createdAt: "c", updatedAt: "u" },
    messages: [
      { id: "m1", role: "assistant", content: "hello", toolName: "Bash", toolStatus: "success", toolArgs: { command: "ls" } },
    ],
    meta: { exportedAt: "2026-09-28T10:00:00.000Z", truncatedFields: ["content"] },
  });
  assert.ok(md.startsWith("# T"));
  assert.ok(md.includes("## assistant · Bash"));
  assert.ok(md.includes("**arguments**"));
  assert.ok(md.includes("truncated fields: content"));
});

// ----------------------------------------------------------- archive store

test("archive store round-trips records, checkpoints and exports", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recorder-store-"));
  try {
    const store = createArchiveStore({ root: dir });
    store.prepare();
    assert.ok(existsSync(path.join(dir, "index.json")));
    assert.ok(existsSync(path.join(dir, "sessions")));

    store.appendRecords("s1", [{ type: "session", sessionId: "s1", title: "First" }]);
    store.appendRecords("s1", [
      { type: "message", id: "m1", role: "user", content: "hi" },
      { type: "message", id: "m2", role: "assistant", content: "hello" },
    ]);
    // A torn tail line must be skipped rather than break the read.
    writeFileSync(store.sessionFile("s1"), '{"type":"message","id":"m3"\n', { flag: "a" });

    const archive = store.readArchive("s1");
    assert.equal(archive.messages.length, 2);
    assert.equal(archive.header.title, "First");

    store.setCheckpoint("s1", { storedMessages: 2, updatedAt: "2026-09-28T10:00:00.000Z", bytes: store.totalBytes() });
    assert.equal(store.checkpoint("s1").storedMessages, 2);
    assert.equal(store.listArchives().length, 1);

    const file = store.writeExport("s1.md", "# hello");
    assert.ok(readFileSync(file, "utf8").includes("hello"));
    assert.equal(store.listExports().length, 1);

    assert.equal(store.deleteArchive("s1"), true);
    assert.equal(store.checkpoint("s1"), null);
    assert.ok(!existsSync(store.sessionFile("s1")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archive store keeps one rotated predecessor and reads it back", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recorder-rotate-"));
  try {
    const store = createArchiveStore({ root: dir, rotateBytes: 120 });
    store.prepare();
    for (let i = 0; i < 6; i += 1) {
      store.appendRecords("s1", [{ type: "message", id: `m${i}`, role: "user", content: "x".repeat(40) }]);
    }
    const records = store.readRecords("s1");
    assert.ok(records.length > 3, `expected records from both files, got ${records.length}`);
    assert.ok(existsSync(path.join(dir, "sessions", "s1.1.jsonl")), "rotation should leave a predecessor");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeExport sanitizes the requested file name", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recorder-export-"));
  try {
    const store = createArchiveStore({ root: dir });
    store.prepare();
    const file = store.writeExport("../../escape attempt.md", "x");
    assert.ok(file.startsWith(path.join(dir, "exports")), file);
    assert.ok(!file.includes(".."));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
