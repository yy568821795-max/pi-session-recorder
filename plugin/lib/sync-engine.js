"use strict";

/**
 * Sync engine: reads host sessions, normalizes them, and persists them.
 *
 * The host surface is injected (`host.listSessions`, `host.getSession`) so the
 * whole engine runs against a fake host in tests, and so a future host API
 * change is a one-file edit.
 *
 * Three invariants matter more than completeness:
 *
 *   1. A failed read never destroys what is already archived. Errors become
 *      `gap` records and the previous file is left untouched.
 *   2. Nothing claims to be complete when it is not. A cap, a page limit, or a
 *      fetch failure all mark the session incomplete rather than quietly
 *      producing a short transcript.
 *   3. One problem is reported once. A fetch error is a fetch error; it is not
 *      also reported as an unexplained short window.
 */

const core = require("./recorder-core");

const DEFAULT_PAGE_SIZE = 200;
/** Hard stop on the backward walk, so a broken cursor cannot spin forever. */
const MAX_PAGES = 200;

function createSyncEngine(options) {
  const store = options.store;
  const host = options.host;
  const log = typeof options.log === "function" ? options.log : () => {};
  const now = typeof options.now === "function" ? options.now : () => new Date().toISOString();

  if (!store) throw new Error("sync engine requires a store");
  if (!host) throw new Error("sync engine requires a host adapter");

  let settings = { ...(options.settings ?? {}) };
  let running = null;
  const state = { lastRunAt: null, lastResult: null, running: false };

  function updateSettings(next) {
    settings = { ...settings, ...(next ?? {}) };
    return settings;
  }

  function resolvedSettings() {
    return {
      pageSize: core.clampInt(settings.pageSize, 1, 500, DEFAULT_PAGE_SIZE),
      maxMessagesPerSession: core.clampInt(settings.maxMessagesPerSession, 1, 1_000_000, 20000),
      maxContentChars: core.clampInt(settings.maxContentChars, 200, 4_000_000, 20000),
      includeToolPayloads: settings.includeToolPayloads !== false,
      redactSecrets: settings.redactSecrets !== false,
      hostContentLimit: core.clampInt(settings.hostContentLimit, 1000, 512_000, 200_000),
    };
  }

  /**
   * Walk the host read window backwards until the transcript start, a cap, or
   * an error. Confirmed host semantics: `messageBefore` is an exclusive end
   * coordinate counted from the start, and omitting it reads the newest window.
   *
   * @returns {{messages: object[], compactions: object[], truncations: object,
   *            redactions: number, pages: number, complete: boolean,
   *            capped: boolean, error: string|null}}
   */
  async function fetchTranscript(summary, limits) {
    const collected = [];
    const truncations = {};
    let redactions = 0;
    let cursor = null;
    let pages = 0;
    let complete = false;
    let capped = false;
    let error = null;
    let compactions = [];

    while (pages < MAX_PAGES) {
      const request = core.nextWindowRequest(
        summary.id,
        cursor === null ? undefined : cursor,
        limits.pageSize,
        collected.length,
        limits.maxMessagesPerSession,
      );
      if (!request) {
        // The cap stopped the walk while older messages may still exist, so
        // this is a gap rather than a clean end of history.
        capped = true;
        break;
      }

      let payload;
      try {
        payload = await host.getSession({ ...request, contentLimit: limits.hostContentLimit });
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
        break;
      }

      const detail = core.extractSessionDetail(payload);
      if (!detail) {
        error = "host returned no session detail";
        break;
      }
      pages += 1;
      if (pages === 1) compactions = detail.compactions;

      for (const raw of detail.messages) {
        const { record, state: sanitizerState } = core.normalizeMessage(raw, limits);
        if (!record) continue;
        collected.push(record);
        redactions += sanitizerState.redactions;
        for (const [field, length] of Object.entries(sanitizerState.truncations)) {
          const previous = truncations[field];
          if (!previous || length > previous) truncations[field] = length;
        }
      }

      if (!detail.hasMoreBefore) {
        complete = true;
        break;
      }
      const next = detail.messageStart;
      if (!Number.isFinite(next) || next <= 0 || next === cursor || detail.messages.length === 0) {
        // Cannot advance. Report incompleteness instead of looping forever.
        break;
      }
      cursor = next;
    }

    return { messages: collected, compactions, truncations, redactions, pages, complete, capped, error };
  }

  /** Reasons an archive is not a complete transcript, in reader-facing terms. */
  function problemsOf(fetched, merged, plan, previousCount) {
    const problems = [];
    if (fetched.error) {
      problems.push(`fetch-error: ${fetched.error}`);
    } else if (fetched.capped) {
      problems.push(`message-cap: stopped at ${merged.messages.length}`);
    } else if (!fetched.complete) {
      problems.push("incomplete-transcript-window");
    }
    if (merged.dropped > 0) problems.push(`dropped-oldest: ${merged.dropped}`);
    if (plan.mode === "full" && previousCount > 0) problems.push(`rewritten: ${plan.reason}`);
    return problems;
  }

  async function syncSession(summary, runOptions = {}) {
    const limits = resolvedSettings();
    const sessionId = summary.id;
    const checkpoint = store.checkpoint(sessionId);
    const plan = runOptions.force
      ? { needed: true, mode: checkpoint ? "incremental" : "full", reason: "forced" }
      : core.planSync(summary, checkpoint);
    if (!plan.needed) {
      return { sessionId, status: "skipped", reason: plan.reason, appended: 0, stored: 0 };
    }

    // Read the current epoch once: it decides both what to merge and whether a
    // new epoch is needed.
    const current = store.readArchive(sessionId);
    const previousCount = current.messages.length;
    const existing = plan.mode === "full" ? [] : current.messages;
    const fetched = await fetchTranscript(summary, limits);
    const merged = core.mergeMessages(existing, fetched.messages, {
      maxMessagesPerSession: limits.maxMessagesPerSession,
    });

    const at = now();
    const records = [];

    // A header line opens an epoch, so it is written only when the epoch really
    // changes: the first archive, a rewrite, or a cap that re-bases the file.
    // An ordinary incremental sync must not open one, or the messages already
    // in the file would fall outside the current view.
    const snapshotEpoch = plan.mode === "full" || merged.dropped > 0;
    const writeHeader = snapshotEpoch || !current.header;
    if (writeHeader) {
      records.push({
        type: "session",
        schema: core.SCHEMA_VERSION,
        recordedAt: at,
        ...summary,
      });
    }

    // A new epoch must contain exactly the merged transcript; an incremental
    // sync appends only what the archive does not already hold.
    const known = new Set(existing.map((record) => record.id));
    const appended = snapshotEpoch
      ? merged.messages
      : merged.messages.filter((record) => !known.has(record.id));
    for (const record of appended) {
      records.push({ type: "message", ...record });
    }

    for (const compaction of fetched.compactions) {
      const normalized = core.normalizeCompaction(compaction, {
        maxContentChars: limits.maxContentChars,
        redactSecrets: limits.redactSecrets,
      });
      if (normalized) records.push({ type: "compaction", ...normalized });
    }

    const problems = problemsOf(fetched, merged, plan, previousCount);
    for (const problem of problems) {
      records.push({ type: "gap", at, reason: problem, detail: { mode: plan.mode, pages: fetched.pages } });
    }

    records.push({
      type: "sync",
      at,
      mode: plan.mode,
      reason: plan.reason,
      pages: fetched.pages,
      fetched: fetched.messages.length,
      appended: appended.length,
      stored: merged.messages.length,
      incomplete: problems.length > 0,
    });

    const lines = store.appendRecords(sessionId, records);
    const row = store.setCheckpoint(sessionId, {
      sessionId,
      title: summary.title ?? null,
      storedMessages: merged.messages.length,
      updatedAt: summary.updatedAt ?? null,
      lastSyncAt: at,
      lastSyncMode: plan.mode,
      lastSyncReason: plan.reason,
      incomplete: problems.length > 0,
      problems,
      pages: fetched.pages,
      redactions: (checkpoint?.redactions ?? 0) + fetched.redactions,
      truncatedFields: Object.keys(fetched.truncations).sort(),
      bytes: store.totalBytes(),
    });

    log(
      `synced ${sessionId}: mode=${plan.mode} appended=${appended.length} stored=${merged.messages.length}` +
        (problems.length ? ` problems=${problems.join(",")}` : ""),
    );

    return {
      sessionId,
      status: problems.length ? "partial" : "ok",
      mode: plan.mode,
      reason: plan.reason,
      appended: appended.length,
      stored: merged.messages.length,
      lines,
      pages: fetched.pages,
      redactions: fetched.redactions,
      problems,
      checkpoint: row,
    };
  }

  async function syncAll(runOptions = {}) {
    if (running) return running;
    running = (async () => {
      state.running = true;
      const startedAt = now();
      const result = {
        startedAt,
        finishedAt: null,
        listed: 0,
        synced: 0,
        skipped: 0,
        partial: 0,
        failed: 0,
        sessions: [],
        listError: null,
      };

      let summaries = [];
      try {
        summaries = await host.listSessions();
      } catch (error) {
        result.listError = error instanceof Error ? error.message : String(error);
        result.failed = 1;
      }
      result.listed = summaries.length;

      const only = runOptions.sessionId ? String(runOptions.sessionId) : null;
      for (const summary of summaries) {
        if (only && summary.id !== only) continue;
        try {
          const outcome = await syncSession(summary, runOptions);
          result.sessions.push(outcome);
          if (outcome.status === "skipped") result.skipped += 1;
          else if (outcome.status === "ok") result.synced += 1;
          else if (outcome.status === "partial") result.partial += 1;
          else result.failed += 1;
        } catch (error) {
          result.failed += 1;
          const message = error instanceof Error ? error.message : String(error);
          result.sessions.push({ sessionId: summary.id, status: "error", error: message });
          log(`sync failed for ${summary.id}: ${message}`);
        }
        if (typeof runOptions.onProgress === "function") {
          runOptions.onProgress({
            sessionId: summary.id,
            done: result.sessions.length,
            total: summaries.length,
          });
        }
      }

      result.finishedAt = now();
      state.lastRunAt = result.finishedAt;
      state.lastResult = result;
      state.running = false;
      running = null;
      return result;
    })();
    return running;
  }

  return {
    syncAll,
    syncSession,
    updateSettings,
    resolvedSettings,
    getState: () => ({ ...state }),
    isRunning: () => state.running,
  };
}

module.exports = { createSyncEngine, DEFAULT_PAGE_SIZE, MAX_PAGES };
