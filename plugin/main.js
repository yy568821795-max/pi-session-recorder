"use strict";

/**
 * Session Recorder - PI-Desktop plugin entry.
 *
 * Host injects the global `pi`. Three surfaces share one archive:
 *
 *   command     "会话记录器：打开" opens the panel
 *   agent tool  session_archive_query lets the agent search the local archive
 *   service     a bounded interval keeps the archive current while the app runs
 *
 * All file IO happens in this plugin process (which is a Node environment, as
 * the log-viewer plugin also relies on) and is confined to the plugin's own
 * data directory. The host database and the host transcript files are never
 * opened, and nothing here reaches the network.
 */

const fs = require("node:fs");
const path = require("node:path");

const core = require("./lib/recorder-core");
const { createArchiveStore } = require("./lib/archive-store");
const { createHostAdapter } = require("./lib/host-adapter");
const { createSyncEngine } = require("./lib/sync-engine");

const COMMAND_ID = "session-recorder.open";
const TOOL_NAME = "session_archive_query";
const SERVICE_ID = "sync";
/** Sessions read per search call, and the largest archive read in one go. */
const SEARCH_SESSION_LIMIT = 20;
const SEARCH_MAX_FILE_BYTES = 16 * 1024 * 1024;

let store = null;
let engine = null;
let settings = null;
let timer = null;
let lastError = null;
const logLines = [];

function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  logLines.push(line);
  if (logLines.length > 500) logLines.shift();
  try {
    if (store) {
      fs.appendFileSync(path.join(store.root, "recorder.log"), `${line}\n`, "utf8");
    }
  } catch {
    // Logging must never break the recorder.
  }
}

function settingsView() {
  return {
    autoSync: settings?.autoSync !== false,
    intervalMinutes: core.clampInt(settings?.intervalMinutes, 1, 240, 5),
    pageSize: core.clampInt(settings?.pageSize, 1, 500, 200),
    maxMessagesPerSession: core.clampInt(settings?.maxMessagesPerSession, 1, 1_000_000, 20000),
    maxContentChars: core.clampInt(settings?.maxContentChars, 200, 4_000_000, 20000),
    includeToolPayloads: settings?.includeToolPayloads !== false,
    redactSecrets: settings?.redactSecrets !== false,
    maxArchiveMb: core.clampInt(settings?.maxArchiveMb, 16, 100_000, 512),
  };
}

function statusPayload() {
  const view = settingsView();
  const archives = store ? store.listArchives() : [];
  const bytes = store ? store.totalBytes() : 0;
  const budget = view.maxArchiveMb * 1024 * 1024;
  const engineState = engine ? engine.getState() : { running: false, lastResult: null, lastRunAt: null };
  return {
    ok: true,
    pluginId: pi.plugin.getId(),
    storage: store ? store.storageInfo() : null,
    settings: view,
    totals: {
      sessions: archives.length,
      messages: archives.reduce((sum, row) => sum + (Number(row.storedMessages) || 0), 0),
      bytes,
      bytesLabel: core.formatBytes(bytes),
      budgetLabel: core.formatBytes(budget),
      overBudget: bytes > budget,
    },
    running: engineState.running,
    lastRunAt: engineState.lastRunAt,
    lastResult: engineState.lastResult,
    lastError,
    logTail: logLines.slice(-40),
  };
}

/** Bounded read of archived sessions for search; never loads the whole archive. */
function collectForSearch(maxSessions) {
  const rows = store.listArchives().slice(0, maxSessions);
  const out = [];
  for (const row of rows) {
    const file = store.sessionFile(row.sessionId);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue;
    }
    if (size > SEARCH_MAX_FILE_BYTES) {
      out.push({
        summary: { id: row.sessionId, title: row.title, updatedAt: row.updatedAt },
        messages: [],
        skipped: "archive too large for a bounded search",
      });
      continue;
    }
    const archive = store.readArchive(row.sessionId);
    out.push({ summary: archive.summary ?? row, messages: archive.messages });
  }
  return out;
}

async function runSync(runOptions = {}) {
  if (!engine) return { ok: false, error: "recorder not ready" };
  if (engine.isRunning()) return { ok: true, alreadyRunning: true };
  try {
    const result = await engine.syncAll(runOptions);
    lastError = result.listError ?? null;
    return { ok: !result.listError, result, status: statusPayload() };
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    log(`sync failed: ${lastError}`);
    return { ok: false, error: lastError, status: statusPayload() };
  }
}

function scheduleTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  const view = settingsView();
  if (!view.autoSync) return;
  timer = setInterval(() => {
    void runSync({});
  }, view.intervalMinutes * 60_000);
  if (typeof timer.unref === "function") timer.unref();
}

/** Panel commands. Every one returns a plain JSON-serializable payload. */
async function handlePanelRequest(channel, payload = {}) {
  const op = String(channel || "").replace(/^recorder\./, "");
  switch (op) {
    case "status":
      return statusPayload();
    case "list": {
      const archives = store.listArchives().map((row) => ({
        ...row,
        bytesLabel: core.formatBytes(row.bytes),
      }));
      return { ok: true, archives, status: statusPayload() };
    }
    case "get": {
      const sessionId = String(payload.sessionId ?? "");
      if (!sessionId) return { ok: false, error: "sessionId required" };
      const archive = store.readArchive(sessionId);
      const summary = core.summarizeArchive([
        { type: "session" },
        ...archive.messages.map((record) => ({ type: "message", ...record })),
      ]);
      return {
        ok: true,
        sessionId,
        header: archive.header,
        stats: summary,
        checkpoint: store.checkpoint(sessionId),
        messages: archive.messages.slice(-core.clampInt(payload.limit, 1, 5000, 500)),
        gaps: archive.gaps.slice(-50),
        syncs: archive.syncs.slice(-20),
      };
    }
    case "sync":
      return runSync(payload.sessionId ? { sessionId: payload.sessionId, force: true } : { force: payload.force === true });
    case "export": {
      const sessionId = String(payload.sessionId ?? "");
      if (!sessionId) return { ok: false, error: "sessionId required" };
      const archive = store.readArchive(sessionId);
      if (!archive.messages.length && !archive.header) {
        return { ok: false, error: "nothing archived for that session yet" };
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const base = `${core.safeFileName(sessionId)}-${stamp}`;
      const results = {};
      if (payload.format === "jsonl" || payload.format === "both") {
        const lines = [archive.header, ...archive.messages.map((record) => ({ type: "message", ...record }))].filter(Boolean);
        results.jsonl = store.writeExport(`${base}.jsonl`, core.toJsonl(lines));
      }
      if (payload.format === "md" || payload.format === "both" || !payload.format) {
        results.markdown = store.writeExport(
          `${base}.md`,
          core.toMarkdown({
            summary: archive.header ?? { id: sessionId },
            messages: archive.messages,
            meta: {
              exportedAt: new Date().toISOString(),
              incomplete: (store.checkpoint(sessionId)?.problems ?? []).length > 0,
              truncatedFields: store.checkpoint(sessionId)?.truncatedFields ?? [],
            },
          }),
        );
      }
      return { ok: true, files: results, status: statusPayload() };
    }
    case "delete": {
      const sessionId = String(payload.sessionId ?? "");
      if (!sessionId) return { ok: false, error: "sessionId required" };
      return { ok: true, deleted: store.deleteArchive(sessionId), status: statusPayload() };
    }
    case "search": {
      const sessions = collectForSearch(core.clampInt(payload.sessions, 1, 50, SEARCH_SESSION_LIMIT));
      return {
        ok: true,
        hits: core.searchArchive(sessions, payload.query ?? "", {
          limit: payload.limit,
          excerptChars: payload.excerptChars,
        }),
      };
    }
    case "openStorage":
      return { ok: true, info: store.storageInfo() };
    default:
      return { ok: false, error: `unknown channel: ${channel}` };
  }
}

async function onLoad() {
  settings = await pi.plugin.getSettings();
  const dataPath = await pi.plugin.getDataPath();
  const root = path.join(dataPath, "archive");
  store = createArchiveStore({ root });
  store.prepare();

  engine = createSyncEngine({
    store,
    host: createHostAdapter(pi),
    settings: settingsView(),
    log,
  });

  await pi.commands.register({
    id: COMMAND_ID,
    title: "会话记录器：打开",
    keywords: ["session", "recorder", "archive", "会话", "记录", "归档"],
    category: "Developer Tools",
    run: async () => {
      await pi.ui.openPanel();
    },
  });

  await pi.agent.registerTool({
    name: TOOL_NAME,
    description:
      "Search this device's locally archived conversations and return matching session metadata with bounded excerpts.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Case-insensitive text to look for. Empty lists the newest sessions." },
        sessionId: { type: "string", description: "Restrict to one session id." },
        limit: { type: "number", description: "Maximum sessions to return (default 10, max 50)." },
        excerptChars: { type: "number", description: "Maximum characters per hit (default 240, max 2000)." },
      },
    },
    execute: async (args = {}) => {
      const sessionId = args.sessionId ? String(args.sessionId) : null;
      if (sessionId) {
        if (!store.checkpoint(sessionId)) {
          return { ok: false, error: "that session is not archived yet; run a sync first" };
        }
        const archive = store.readArchive(sessionId);
        const needle = String(args.query ?? "").trim().toLowerCase();
        const messages = archive.messages
          .filter((record) => !needle || String(record.content ?? "").toLowerCase().includes(needle))
          .slice(-core.clampInt(args.limit, 1, 50, 10))
          .map((record) => ({
            id: record.id,
            role: record.role,
            at: record.createdAt,
            toolName: record.toolName ?? null,
            excerpt: core.excerpt(record.content, core.clampInt(args.excerptChars, 40, 2000, 240)),
          }));
        return { ok: true, sessionId, title: archive.header?.title ?? null, matches: messages };
      }
      const sessions = collectForSearch(SEARCH_SESSION_LIMIT);
      const hits = core.searchArchive(sessions, args.query ?? "", {
        limit: args.limit,
        excerptChars: args.excerptChars,
      });
      return { ok: true, count: hits.length, hits };
    },
  });

  pi.services.register({
    id: SERVICE_ID,
    start: ({ log: serviceLog }) => {
      serviceLog("session recorder sync service started");
      scheduleTimer();
    },
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  });

  // A turn boundary is a hint, not a guarantee: delivery is best effort, so it
  // only shortens the delay until the interval would have run anyway.
  try {
    if (typeof pi.events?.on === "function") {
      pi.events.on("session:turnEnded", () => {
        if (settingsView().autoSync) void runSync({});
      });
    }
  } catch (error) {
    log(`event subscription unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  log(`recorder ready; archive root ${root}`);
  if (settingsView().autoSync) void runSync({});
}

async function onUnload() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  try {
    await pi.commands.unregister(COMMAND_ID);
  } catch {
    // already gone
  }
  try {
    await pi.agent.unregisterTool(TOOL_NAME);
  } catch {
    // already gone
  }
  engine = null;
  store = null;
}

async function onPanelInvoke(channel, payload) {
  if (!store || !engine) throw new Error("recorder not ready");
  try {
    return await handlePanelRequest(channel, payload ?? {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`panel ${channel} failed: ${message}`);
    return { ok: false, error: message };
  }
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  // Exported for tests and for a future host that can drive the engine directly.
  __internals: {
    handlePanelRequest,
    collectForSearch,
    settingsView,
    statusPayload,
    logLines,
  },
};
