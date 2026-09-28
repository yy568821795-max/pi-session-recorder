import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { createArchiveStore } = require("../plugin/lib/archive-store.js");
const { createSyncEngine } = require("../plugin/lib/sync-engine.js");

/**
 * A fake host that reproduces the confirmed `session/get` window semantics:
 * `messageBefore` is an exclusive end coordinate measured from the start of the
 * transcript, and omitting it reads the newest window.
 */
function createFakeHost(sessions, options = {}) {
  const state = { getCalls: [], listCalls: 0, failGet: options.failGet ?? null, failList: options.failList ?? false };
  const pad = (n) => String(n).padStart(3, "0");
  const messageList = (count) =>
    Array.from({ length: count }, (_, i) => ({
      id: `m${pad(i)}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i} with apiKey sk-live-abcdefghijklmnop${i}`,
      createdAt: `2026-09-28T10:00:${pad(i).slice(-2)}.000Z`,
    }));

  return {
    state,
    async listSessions() {
      state.listCalls += 1;
      if (state.failList) throw new Error("host unavailable");
      return sessions.map((session) => ({ ...session, messages: undefined }));
    },
    async getSession(request) {
      state.getCalls.push({ ...request });
      if (state.failGet) throw new Error(state.failGet);
      const session = sessions.find((entry) => entry.id === request.id);
      if (!session) throw new Error("session not found");
      const all = messageList(session.messageCount);
      const limit = Number.isFinite(request.messageLimit) ? request.messageLimit : all.length;
      const before = Number.isFinite(request.messageBefore) ? Math.min(request.messageBefore, all.length) : all.length;
      const start = Math.max(0, before - limit);
      return {
        session: {
          id: session.id,
          title: session.title,
          messageCount: session.messageCount,
          updatedAt: session.updatedAt,
          modelId: "test-model",
          messages: all.slice(start, before),
          messageStart: start,
          messageEnd: before,
          hasMoreBefore: start > 0,
          hasMoreAfter: before < all.length,
        },
      };
    },
  };
}

function withStore(run) {
  const dir = mkdtempSync(path.join(tmpdir(), "recorder-engine-"));
  try {
    const store = createArchiveStore({ root: dir });
    store.prepare();
    return run(store);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("first sync archives every page and redacts secrets on the way to disk", async () => {
  await withStore(async (store) => {
    const host = createFakeHost([{ id: "s1", title: "T", messageCount: 5, updatedAt: "2026-09-28T11:00:00.000Z" }]);
    const engine = createSyncEngine({ store, host, settings: { pageSize: 2, redactSecrets: true } });
    const result = await engine.syncAll({});

    assert.equal(result.listed, 1);
    assert.equal(result.synced, 1);
    const archive = store.readArchive("s1");
    assert.equal(archive.messages.length, 5);
    // Walking backwards must still produce an ascending transcript.
    assert.deepEqual(archive.messages.map((m) => m.id), ["m000", "m001", "m002", "m003", "m004"]);
    assert.ok(!JSON.stringify(archive.messages).includes("sk-live-abcdefghijklmnop"));
    assert.equal(host.state.getCalls.length, 3, "two-full pages plus a partial one");
    assert.equal(host.state.getCalls[0].messageBefore, undefined, "first request reads the newest window");

    const checkpoint = store.checkpoint("s1");
    assert.equal(checkpoint.storedMessages, 5);
    assert.equal(checkpoint.incomplete, false);
    assert.equal(checkpoint.redactions > 0, true);
  });
});

test("an unchanged session is skipped and a grown one appends only the new messages", async () => {
  await withStore(async (store) => {
    const sessions = [{ id: "s1", title: "T", messageCount: 3, updatedAt: "2026-09-28T11:00:00.000Z" }];
    const host = createFakeHost(sessions);
    const engine = createSyncEngine({ store, host, settings: { pageSize: 100 } });

    await engine.syncAll({});
    const second = await engine.syncAll({});
    assert.equal(second.skipped, 1);
    assert.equal(store.readArchive("s1").messages.length, 3);

    sessions[0].messageCount = 5;
    sessions[0].updatedAt = "2026-09-28T12:00:00.000Z";
    const third = await engine.syncAll({});
    assert.equal(third.synced, 1);
    assert.equal(third.sessions[0].mode, "incremental");
    assert.equal(third.sessions[0].appended, 2);
    assert.equal(store.readArchive("s1").messages.length, 5);
    assert.equal(store.checkpoint("s1").storedMessages, 5);
  });
});

test("a fetch failure is recorded as a gap and never destroys archived data", async () => {
  await withStore(async (store) => {
    const sessions = [{ id: "s1", title: "T", messageCount: 3, updatedAt: "2026-09-28T11:00:00.000Z" }];
    const host = createFakeHost(sessions);
    const engine = createSyncEngine({ store, host, settings: { pageSize: 100 } });
    await engine.syncAll({});
    assert.equal(store.readArchive("s1").messages.length, 3);

    sessions[0].messageCount = 9;
    sessions[0].updatedAt = "2026-09-28T13:00:00.000Z";
    host.state.failGet = "connection reset";
    const failed = await engine.syncAll({});

    assert.equal(failed.partial, 1);
    assert.ok(failed.sessions[0].problems.some((problem) => problem.startsWith("fetch-error")));
    const archive = store.readArchive("s1");
    assert.equal(archive.messages.length, 3, "previous archive is preserved");
    assert.equal(archive.gaps.length, 1);
    assert.equal(archive.gaps[0].reason.startsWith("fetch-error"), true);
    assert.equal(store.checkpoint("s1").incomplete, true);
  });
});

test("the message cap archives the newest records and reports the cap", async () => {
  await withStore(async (store) => {
    const host = createFakeHost([{ id: "s1", title: "T", messageCount: 4, updatedAt: "2026-09-28T11:00:00.000Z" }]);
    const engine = createSyncEngine({ store, host, settings: { pageSize: 100, maxMessagesPerSession: 2 } });
    await engine.syncAll({});
    const archive = store.readArchive("s1");
    assert.equal(archive.messages.length, 2);
    // The cap stopped the backward walk while older messages still existed, so
    // the archive must say so rather than look like a 2-message session.
    assert.ok(
      archive.gaps.some((gap) => gap.reason.startsWith("message-cap")),
      `expected a message-cap gap, got ${JSON.stringify(archive.gaps.map((gap) => gap.reason))}`,
    );
    assert.equal(store.checkpoint("s1").incomplete, true);
  });
});
test("a session list failure is reported without throwing", async () => {
  await withStore(async (store) => {
    const host = createFakeHost([], { failList: true });
    const engine = createSyncEngine({ store, host });
    const result = await engine.syncAll({});
    assert.equal(result.failed, 1);
    assert.equal(result.listError, "host unavailable");
    assert.equal(result.listed, 0);
  });
});

test("a rewritten (shorter) transcript resets the archive instead of keeping stale history", async () => {
  await withStore(async (store) => {
    const sessions = [{ id: "s1", title: "T", messageCount: 6, updatedAt: "2026-09-28T11:00:00.000Z" }];
    const host = createFakeHost(sessions);
    const engine = createSyncEngine({ store, host, settings: { pageSize: 100 } });
    await engine.syncAll({});
    assert.equal(store.readArchive("s1").messages.length, 6);

    sessions[0].messageCount = 2;
    const result = await engine.syncAll({});
    assert.equal(result.sessions[0].mode, "full");
    assert.ok(result.sessions[0].problems.includes("rewritten: transcript-shrank"));
    assert.equal(store.readArchive("s1").messages.length, 2);
  });
});

test("a forced sync re-reads a session that would otherwise be skipped", async () => {
  await withStore(async (store) => {
    const host = createFakeHost([{ id: "s1", title: "T", messageCount: 2, updatedAt: "2026-09-28T11:00:00.000Z" }]);
    const engine = createSyncEngine({ store, host, settings: { pageSize: 100 } });
    await engine.syncAll({});
    const before = host.state.getCalls.length;
    const forced = await engine.syncAll({ force: true });
    assert.equal(forced.skipped, 0);
    assert.ok(host.state.getCalls.length > before);
  });
});
