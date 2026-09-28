"use strict";

/**
 * Filesystem layer for the Session Recorder archive.
 *
 * The store owns exactly one directory tree and writes nowhere else:
 *
 *   <root>/index.json              per-session checkpoints and counters
 *   <root>/sessions/<id>.jsonl     one JSONL file per session
 *   <root>/sessions/<id>.1.jsonl   the single rotated predecessor
 *   <root>/exports/<name>          JSONL and Markdown exports
 *
 * `root` is injected so the whole store can be exercised against a temporary
 * directory in tests instead of a real plugin data path.
 *
 * Every mutating write is temp-file plus rename, so a crash leaves either the
 * old file or the new one and never a half-written index.
 */

const fs = require("node:fs");
const path = require("node:path");

const INDEX_SCHEMA_VERSION = 1;
const INDEX_FILE = "index.json";
const SESSIONS_DIR = "sessions";
const EXPORTS_DIR = "exports";
/** Rotate a session file once it passes this size; one predecessor is kept. */
const ROTATE_BYTES = 32 * 1024 * 1024;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeFileAtomic(file, contents) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, contents, "utf8");
  fs.renameSync(temp, file);
}

function emptyIndex() {
  return { schemaVersion: INDEX_SCHEMA_VERSION, updatedAt: null, sessions: {} };
}

function createArchiveStore(options = {}) {
  const root = options.root;
  if (!root || typeof root !== "string") {
    throw new Error("archive store requires a root directory");
  }
  const rotateBytes = Number.isFinite(options.rotateBytes) && options.rotateBytes > 0
    ? options.rotateBytes
    : ROTATE_BYTES;

  const indexFile = () => path.join(root, INDEX_FILE);
  const sessionsDir = () => path.join(root, SESSIONS_DIR);
  const exportsDir = () => path.join(root, EXPORTS_DIR);

  function prepare() {
    fs.mkdirSync(sessionsDir(), { recursive: true });
    fs.mkdirSync(exportsDir(), { recursive: true });
    if (!fs.existsSync(indexFile())) writeIndex(emptyIndex());
  }

  function readIndex() {
    const parsed = readJson(indexFile(), null);
    if (!parsed || typeof parsed !== "object") return emptyIndex();
    if (!parsed.sessions || typeof parsed.sessions !== "object") parsed.sessions = {};
    return parsed;
  }

  function writeIndex(index) {
    const next = {
      schemaVersion: INDEX_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      sessions: index?.sessions && typeof index.sessions === "object" ? index.sessions : {},
    };
    writeFileAtomic(indexFile(), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  function updateIndex(mutator) {
    const index = readIndex();
    mutator(index.sessions);
    return writeIndex(index);
  }

  function sessionFile(sessionId) {
    return path.join(sessionsDir(), `${sessionId}.jsonl`);
  }

  function rotatedFile(sessionId) {
    return path.join(sessionsDir(), `${sessionId}.1.jsonl`);
  }

  function fileBytes(file) {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  }

  function rotateIfNeeded(sessionId) {
    const file = sessionFile(sessionId);
    if (fileBytes(file) < rotateBytes) return false;
    fs.renameSync(file, rotatedFile(sessionId));
    return true;
  }

  function appendRecords(sessionId, records) {
    const lines = [];
    for (const record of records ?? []) {
      if (!record) continue;
      lines.push(JSON.stringify(record));
    }
    if (!lines.length) return 0;
    fs.mkdirSync(sessionsDir(), { recursive: true });
    rotateIfNeeded(sessionId);
    fs.appendFileSync(sessionFile(sessionId), `${lines.join("\n")}\n`, "utf8");
    return lines.length;
  }

  /** Read one archive back. Unknown or torn lines are skipped, never fatal. */
  function readRecords(sessionId) {
    const out = [];
    const files = [rotatedFile(sessionId), sessionFile(sessionId)];
    for (const file of files) {
      let text;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          out.push(JSON.parse(trimmed));
        } catch {
          // A torn tail line is expected after a crash; skip it.
        }
      }
    }
    return out;
  }

  function recordsOfType(records, type) {
    return records.filter((record) => record && record.type === type);
  }

  /** Archive row view for the panel and for search. */
  /**
   * Current view of one session.
   *
   * A `session` header line opens an epoch: messages before the last header
   * belong to a previous epoch (an earlier rewrite, or a rename) and are not
   * part of the current transcript. Keeping them on disk preserves an audit
   * trail, while this rule stops a rewritten session from reporting stale
   * history as if it were current.
   */
  function readArchive(sessionId) {
    const records = readRecords(sessionId);
    let epochStart = -1;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (records[index]?.type === "session") {
        epochStart = index;
        break;
      }
    }
    const current = epochStart === -1 ? records : records.slice(epochStart);
    const header = epochStart === -1 ? null : records[epochStart];
    return {
      sessionId,
      header,
      summary: header,
      messages: recordsOfType(current, "message"),
      gaps: recordsOfType(current, "gap"),
      syncs: recordsOfType(current, "sync"),
      compactions: recordsOfType(current, "compaction"),
      previousEpochs: epochStart > 0 ? records.slice(0, epochStart).filter((record) => record?.type === "session").length : 0,
    };
  }

  function listArchives() {
    const index = readIndex();
    return Object.values(index.sessions)
      .map((row) => ({
        ...row,
        bytes: Number.isFinite(row.bytes) ? row.bytes : fileBytes(sessionFile(row.sessionId)),
      }))
      .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  }

  function setCheckpoint(sessionId, patch) {
    let row = null;
    updateIndex((sessions) => {
      const previous = sessions[sessionId] && typeof sessions[sessionId] === "object"
        ? sessions[sessionId]
        : { sessionId };
      row = { ...previous, ...patch, sessionId };
      sessions[sessionId] = row;
    });
    return row;
  }

  function checkpoint(sessionId) {
    const index = readIndex();
    const row = index.sessions[sessionId];
    return row && typeof row === "object" ? row : null;
  }

  function deleteArchive(sessionId) {
    let removed = false;
    for (const file of [sessionFile(sessionId), rotatedFile(sessionId)]) {
      if (fs.existsSync(file)) {
        fs.rmSync(file, { force: true });
        removed = true;
      }
    }
    updateIndex((sessions) => {
      if (sessions[sessionId]) {
        delete sessions[sessionId];
        removed = true;
      }
    });
    return removed;
  }

  function totalBytes() {
    let total = 0;
    try {
      for (const entry of fs.readdirSync(sessionsDir())) {
        total += fileBytes(path.join(sessionsDir(), entry));
      }
    } catch {
      return 0;
    }
    return total;
  }

  function writeExport(name, contents) {
    // Dots survive the character filter, so collapse any ".." run and drop a
    // leading dot: a name must never be able to climb out of the exports dir.
    const safe = String(name)
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/\.{2,}/g, "_")
      .replace(/^[._]+/, "")
      .slice(0, 120) || "export";
    const file = path.join(exportsDir(), safe);
    writeFileAtomic(file, contents);
    return file;
  }

  function listExports() {
    try {
      return fs.readdirSync(exportsDir())
        .map((name) => ({ name, bytes: fileBytes(path.join(exportsDir(), name)) }))
        .sort((a, b) => b.bytes - a.bytes);
    } catch {
      return [];
    }
  }

  function storageInfo() {
    return { root, sessions: sessionsDir(), exports: exportsDir(), bytes: totalBytes() };
  }

  return {
    root,
    prepare,
    readIndex,
    writeIndex,
    updateIndex,
    appendRecords,
    readRecords,
    readArchive,
    listArchives,
    setCheckpoint,
    checkpoint,
    deleteArchive,
    totalBytes,
    writeExport,
    listExports,
    storageInfo,
    sessionFile,
    sessionFilePath: (sessionId) => sessionFile(sessionId),
  };
}

module.exports = { createArchiveStore, INDEX_SCHEMA_VERSION, ROTATE_BYTES };
