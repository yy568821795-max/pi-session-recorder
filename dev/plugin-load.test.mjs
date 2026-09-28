import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

/**
 * Load the real plugin entry against a stubbed host global.
 *
 * This is the closest thing to running inside PI-Desktop that a plain Node
 * process can do: the same `main.js`, the same `pi.*` calls the host injects,
 * and the same `session/list` + `session/get` shapes the host IPC returns.
 */
function createFakePi(dataDir, sessions) {
  const pad = (n) => String(n).padStart(3, "0");
  const registry = { commands: [], tools: [], services: [], unregistered: [], events: [] };

  const allMessages = (count) =>
    Array.from({ length: count }, (_, i) => ({
      id: `m${pad(i)}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: i === 0 ? "deploy notes: apiKey sk-live-abcdefghijklmnop" : `message ${i}`,
      createdAt: `2026-09-28T10:00:${pad(i).slice(-2)}.000Z`,
    }));

  return {
    registry,
    pi: {
      plugin: {
        getId: () => "pi.session-recorder",
        getSettings: async () => ({ autoSync: false, pageSize: 100 }),
        setSettings: async () => {},
        getDataPath: async () => dataDir,
        getManifest: () => ({ id: "pi.session-recorder" }),
      },
      commands: {
        register: async (command) => registry.commands.push(command),
        unregister: async (id) => registry.unregistered.push(id),
      },
      agent: {
        registerTool: async (tool) => registry.tools.push(tool),
        unregisterTool: async (id) => registry.unregistered.push(id),
      },
      services: {
        register: async (service) => registry.services.push(service),
      },
      events: {
        on: (event) => registry.events.push(event),
        off: () => {},
      },
      ui: {
        openPanel: async () => {},
        showToast: async () => {},
        notify: async () => {},
      },
      desktop: {
        listOperations: async () => [],
        invoke: async ({ operation, args }) => {
          if (operation === "session/list") {
            return { sessions: sessions.map(({ messages, ...rest }) => rest) };
          }
          if (operation === "session/get") {
            const request = args?.[0] ?? {};
            const session = sessions.find((entry) => entry.id === request.id);
            if (!session) throw new Error("session not found");
            const all = allMessages(session.messageCount);
            const limit = Number.isFinite(request.messageLimit) ? request.messageLimit : all.length;
            const before = Number.isFinite(request.messageBefore)
              ? Math.min(request.messageBefore, all.length)
              : all.length;
            const start = Math.max(0, before - limit);
            return {
              session: {
                id: session.id,
                title: session.title,
                messageCount: session.messageCount,
                updatedAt: session.updatedAt,
                messages: all.slice(start, before),
                messageStart: start,
                messageEnd: before,
                hasMoreBefore: start > 0,
                hasMoreAfter: before < all.length,
              },
            };
          }
          throw new Error(`unexpected operation ${operation}`);
        },
      },
    },
  };
}

async function withPlugin(sessions, run) {
  const dir = mkdtempSync(path.join(tmpdir(), "recorder-plugin-"));
  const previous = globalThis.pi;
  const fake = createFakePi(dir, sessions);
  globalThis.pi = fake.pi;
    const cacheKey = require.resolve("../plugin/main.js");
    const plugin = require("../plugin/main.js");
  try {
    await run({ plugin, fake, dir });
  } finally {
    try {
      await plugin.onUnload();
    } catch {
      /* unload must not throw in the test either */
    }
    if (previous === undefined) delete globalThis.pi;
    else globalThis.pi = previous;
    delete require.cache[cacheKey];
    rmSync(dir, { recursive: true, force: true });
  }
}

test("onLoad registers every surface and creates the archive tree", async () => {
  await withPlugin([{ id: "s1", title: "Deploy notes", messageCount: 3, updatedAt: "2026-09-28T11:00:00.000Z" }], async ({ plugin, fake, dir }) => {
    await plugin.onLoad();

    assert.equal(fake.registry.commands.length, 1);
    assert.equal(fake.registry.commands[0].id, "session-recorder.open");
    assert.equal(fake.registry.tools.length, 1);
    assert.equal(fake.registry.tools[0].name, "session_archive_query");
    assert.equal(fake.registry.services.length, 1);
    assert.equal(fake.registry.services[0].id, "sync");
    assert.ok(fake.registry.events.includes("session:turnEnded"));
    assert.ok(existsSync(path.join(dir, "archive", "index.json")), "archive index should be created");
    assert.ok(existsSync(path.join(dir, "archive", "sessions")));
  });
});

test("sync archives the transcript, redacts secrets and exports both formats", async () => {
  await withPlugin([{ id: "s1", title: "Deploy notes", messageCount: 4, updatedAt: "2026-09-28T11:00:00.000Z" }], async ({ plugin, dir }) => {
    await plugin.onLoad();

    const synced = await plugin.onPanelInvoke("recorder.sync", {});
    assert.equal(synced.ok, true, JSON.stringify(synced.error ?? ""));
    assert.equal(synced.result.synced, 1);

    const list = await plugin.onPanelInvoke("recorder.list", {});
    assert.equal(list.archives.length, 1);
    assert.equal(list.archives[0].storedMessages, 4);
    assert.equal(list.archives[0].title, "Deploy notes");
    assert.equal(list.status.totals.sessions, 1);

    const detail = await plugin.onPanelInvoke("recorder.get", { sessionId: "s1", limit: 50 });
    assert.equal(detail.messages.length, 4);
    assert.equal(detail.header.title, "Deploy notes");
    assert.ok(!JSON.stringify(detail.messages).includes("sk-live-abcdefghijklmnop"), "secret must be redacted on disk");
    assert.equal(detail.checkpoint.incomplete, false);

    const exported = await plugin.onPanelInvoke("recorder.export", { sessionId: "s1", format: "both" });
    assert.ok(exported.files.markdown && exported.files.jsonl);
    const markdown = readFileSync(exported.files.markdown, "utf8");
    const jsonl = readFileSync(exported.files.jsonl, "utf8");
    assert.ok(markdown.includes("Deploy notes"));
    assert.ok(markdown.includes("## user"));
    assert.ok(!jsonl.includes("sk-live-abcdefghijklmnop"));
    assert.equal(jsonl.trim().split("\n").length >= 5, true);

    // The archive itself must not leak the secret either.
    const archiveText = readdirSync(path.join(dir, "archive", "sessions"))
      .map((name) => readFileSync(path.join(dir, "archive", "sessions", name), "utf8"))
      .join("\n");
    assert.ok(!archiveText.includes("sk-live-abcdefghijklmnop"));
  });
});

test("the agent tool searches the local archive and refuses unarchived sessions", async () => {
  await withPlugin([{ id: "s1", title: "Deploy notes", messageCount: 3, updatedAt: "2026-09-28T11:00:00.000Z" }], async ({ plugin, fake }) => {
    await plugin.onLoad();
    const tool = fake.registry.tools[0];

    const missing = await tool.execute({ sessionId: "nope" });
    assert.equal(missing.ok, false);

    await plugin.onPanelInvoke("recorder.sync", {});
    const hit = await tool.execute({ query: "deploy", limit: 5, excerptChars: 80 });
    assert.equal(hit.ok, true);
    assert.equal(hit.count, 1);
    assert.equal(hit.hits[0].sessionId, "s1");
    assert.ok(hit.hits[0].matches[0].excerpt.length <= 81);

    const byId = await tool.execute({ sessionId: "s1", limit: 3 });
    assert.equal(byId.ok, true);
    assert.equal(byId.matches.length, 3);
  });
});

test("delete removes only the local archive and a second sync re-creates it", async () => {
  await withPlugin([{ id: "s1", title: "T", messageCount: 2, updatedAt: "2026-09-28T11:00:00.000Z" }], async ({ plugin }) => {
    await plugin.onLoad();
    await plugin.onPanelInvoke("recorder.sync", {});
    assert.equal((await plugin.onPanelInvoke("recorder.list", {})).archives.length, 1);

    const removed = await plugin.onPanelInvoke("recorder.delete", { sessionId: "s1" });
    assert.equal(removed.deleted, true);
    assert.equal((await plugin.onPanelInvoke("recorder.list", {})).archives.length, 0);

    await plugin.onPanelInvoke("recorder.sync", {});
    assert.equal((await plugin.onPanelInvoke("recorder.list", {})).archives.length, 1);
  });
});

test("an unarchived session list survives a host failure without throwing", async () => {
  await withPlugin([{ id: "s1", title: "T", messageCount: 2, updatedAt: "2026-09-28T11:00:00.000Z" }], async ({ plugin, fake }) => {
    await plugin.onLoad();
    fake.pi.desktop.invoke = async () => {
      throw new Error("host unavailable");
    };
    const reply = await plugin.onPanelInvoke("recorder.sync", {});
    assert.equal(reply.ok, false);
    assert.match(String(reply.result?.listError ?? reply.error), /host unavailable/);
    assert.equal(reply.status.ok, true, "status must still render");
  });
});

test("an unknown panel channel returns a structured error instead of throwing", async () => {
  await withPlugin([{ id: "s1", title: "T", messageCount: 1, updatedAt: "2026-09-28T11:00:00.000Z" }], async ({ plugin }) => {
    await plugin.onLoad();
    const reply = await plugin.onPanelInvoke("recorder.nope", {});
    assert.equal(reply.ok, false);
    assert.match(reply.error, /unknown channel/);
  });
});
