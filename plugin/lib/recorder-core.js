"use strict";

/**
 * Host-free core logic for the Session Recorder plugin.
 *
 * Everything here is pure: it takes host-shaped data in, returns
 * archive-shaped data out, and never touches the filesystem, the network, or
 * the `pi` global. That keeps the interesting rules (redaction, bounding,
 * pagination planning, dedupe, export) unit-testable with plain `node --test`.
 *
 * Host shapes this module is written against (PI-Desktop host-core, schema v17):
 *   SessionSummary: id, title, messageCount, projectPath, modelId, providerId,
 *                   mode, thinkingLevel, permissionMode, createdAt, updatedAt
 *   SessionDetail : summary fields (flattened) + messages[] + messageStart,
 *                   messageEnd, hasMoreBefore, hasMoreAfter
 *   UiMessage     : id, role, content, createdAt, thinking, status, modelId,
 *                   providerId, usage, toolName, toolCallId, toolStatus,
 *                   toolArgs, toolResult, toolDurationMs, toolCompletedAt,
 *                   isError, parentToolCallId, agentName, attachments, ...
 *
 * The archive schema is this module's own and is versioned independently.
 */

const SCHEMA_VERSION = 1;

/**
 * Keys whose values never reach disk in clear text.
 *
 * Matching is deliberately heuristic rather than clever: the key is normalized
 * (lowercase, non-alphanumerics dropped) and then compared against whole words
 * and multi-character fragments. A bare `key` or `sig` is only matched exactly,
 * because `keys`, `keyboard`, and `signatureVersion` are ordinary fields.
 */
const SECRET_KEY_FRAGMENTS = [
  "token",
  "secret",
  "password",
  "passwd",
  "apikey",
  "authorization",
  "cookie",
  "credential",
  "privatekey",
  "clientsecret",
  "accesskey",
  "sessionkey",
  "passphrase",
  "refreshtoken",
  "authkey",
  "bearer",
];

/**
 * Token-counting fields are ordinary metadata, not credentials, even though
 * their names contain "token". Without this exemption `maxTokens` in a tool
 * argument would be redacted and the archived call would lose its meaning.
 */
const TOKEN_COUNT_KEYS = new Set([
  "tokens",
  "totaltokens",
  "maxtokens",
  "inputtokens",
  "outputtokens",
  "cachetokens",
  "reasoningtokens",
  "maxoutputtokens",
  "tokenlimit",
  "tokencount",
]);

/** Normalized keys matched exactly, never as a fragment. */
const SECRET_KEY_EXACT = new Set(["key", "pwd", "sig", "auth", "bearer"]);

/** Patterns applied to free text, because secrets also arrive inside strings. */
const SECRET_TEXT_PATTERNS = [
  // Authorization headers and URL user-info.
  /\b(?:bearer|basic)\s+[A-Za-z0-9\-._~+/=]{8,}/gi,
  // Vendor-prefixed API keys.
  /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|glpat|xox[baprs]|AKIA|ASIA|LTAI|AIza)[-_A-Za-z0-9]{10,}\b/g,
  // Bare JWT-shaped triples.
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\b/g,
  // Secret-bearing query parameters and connection strings.
  /([?&;](?:access_token|refresh_token|api[_-]?key|apikey|token|key|secret|password|sig|signature)=)[^&\s"'#]+/gi,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/gi,
  // Private key blocks.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const REDACTED = "[redacted]";

/** Bound used while walking arbitrary JSON so a hostile payload cannot blow up. */
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_ARRAY = 200;
const DEFAULT_MAX_KEYS = 200;

function asString(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function asNumberOrNull(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeKey(key) {
  return asString(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** @returns {boolean} whether this key name looks like it carries a secret. */
function isSecretKey(key) {
  const normalized = normalizeKey(key);
  if (!normalized) return false;
  if (TOKEN_COUNT_KEYS.has(normalized)) return false;
  if (SECRET_KEY_EXACT.has(normalized)) return true;
  return SECRET_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/**
 * Mask secret-shaped substrings inside free text.
 * @returns {{ text: string, count: number }}
 */
function redactText(input) {
  let text = asString(input);
  let count = 0;
  for (const pattern of SECRET_TEXT_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, (match, prefix) => {
      count += 1;
      // Keep the visible prefix ("authorization=...") so the record still reads
      // as a request rather than as an unexplained gap.
      return prefix ? `${prefix}${REDACTED}` : REDACTED;
    });
  }
  return { text, count };
}

/**
 * Track what a record lost, so a reader can tell deliberate redaction and
 * deliberate truncation apart from a recorder gap.
 */
function createSanitizer(options = {}) {
  const maxChars = Number.isFinite(options.maxContentChars) && options.maxContentChars > 0
    ? Math.floor(options.maxContentChars)
    : 20000;
  const redactSecrets = options.redactSecrets !== false;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxArray = options.maxArray ?? DEFAULT_MAX_ARRAY;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const state = { redactions: 0, truncations: {} };

  function noteTruncation(field, originalLength) {
    if (!field || typeof originalLength !== "number") return;
    const previous = state.truncations[field];
    if (!previous || originalLength > previous) state.truncations[field] = originalLength;
  }

  /** Bound and optionally redact one text field, recording both effects. */
  function text(field, value) {
    if (value === null || value === undefined) return undefined;
    let out = asString(value);
    if (redactSecrets) {
      const masked = redactText(out);
      out = masked.text;
      state.redactions += masked.count;
    }
    if (out.length > maxChars) {
      noteTruncation(field, out.length);
      out = `${out.slice(0, maxChars)}\n…[truncated ${out.length - maxChars} chars]`;
    }
    return out;
  }

  /** Deep-copy a JSON value, redacting secret-shaped keys and bounding size. */
  function deep(field, value, depth = 0, seen = new WeakSet()) {
    if (value === null || value === undefined) return value;
    const type = typeof value;
    if (type === "string") return text(field, value);
    if (type === "number" || type === "boolean") return value;
    if (type === "bigint") return String(value);
    if (type === "function" || type === "symbol") return undefined;
    if (depth >= maxDepth) return "[depth-limit]";
    if (type === "object") {
      if (seen.has(value)) return "[cycle]";
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          if (value.length > maxArray) noteTruncation(`${field}[].length`, value.length);
          return value
            .slice(0, maxArray)
            .map((entry) => deep(field, entry, depth + 1, seen));
        }
        const keys = Object.keys(value);
        if (keys.length > maxKeys) noteTruncation(`${field}.keys`, keys.length);
        const out = {};
        for (const key of keys.slice(0, maxKeys)) {
          if (redactSecrets && isSecretKey(key)) {
            if (value[key] !== undefined && value[key] !== null && value[key] !== "") {
              state.redactions += 1;
            }
            out[key] = REDACTED;
            continue;
          }
          const normalized = deep(`${field}.${key}`, value[key], depth + 1, seen);
          if (normalized !== undefined) out[key] = normalized;
        }
        return out;
      } finally {
        seen.delete(value);
      }
    }
    return undefined;
  }

  return { state, text, deep, maxChars, redactSecrets };
}

/** Compaction records are part of the host detail; keep a bounded summary. */
function normalizeCompaction(raw, sanitizer) {
  if (!raw || typeof raw !== "object") return null;
  return {
    id: asString(raw.id) || null,
    createdAt: asString(raw.createdAt) || null,
    summary: sanitizer.text("compaction.summary", raw.summary),
    throughMessageId: asString(raw.throughMessageId) || null,
    firstKeptMessageId: asString(raw.firstKeptMessageId) || null,
    tokensBefore: asNumberOrNull(raw.tokensBefore),
    providerId: asString(raw.providerId) || null,
    modelId: asString(raw.modelId) || null,
  };
}

/** Attachment metadata only: never the bytes, never a data URL. */
function normalizeAttachments(raw, sanitizer) {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.slice(0, 50).map((entry) => {
    const item = entry && typeof entry === "object" ? entry : {};
    return {
      name: sanitizer.text("attachment.name", item.name ?? item.fileName),
      mimeType: asString(item.mimeType ?? item.type) || null,
      size: asNumberOrNull(item.size),
      // A content-addressed reference is useful for a later lookup and carries
      // no payload, unlike `data`/`dataUrl` fields which are dropped entirely.
      sha256: asString(item.sha256) || null,
    };
  });
}

function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = {
    inputTokens: asNumberOrNull(raw.inputTokens),
    outputTokens: asNumberOrNull(raw.outputTokens),
    cacheReadTokens: asNumberOrNull(raw.cacheReadTokens),
    cacheWriteTokens: asNumberOrNull(raw.cacheWriteTokens),
    reasoningTokens: asNumberOrNull(raw.reasoningTokens),
    totalTokens: asNumberOrNull(raw.totalTokens),
  };
  return Object.values(usage).some((value) => value !== null) ? usage : undefined;
}

/**
 * One host `UiMessage` -> one archive record.
 * @returns {{ record: object|null, state: { redactions: number, truncations: object } }}
 */
function normalizeMessage(raw, options = {}) {
  const sanitizer = createSanitizer(options);
  if (!raw || typeof raw !== "object") {
    return { record: null, state: sanitizer.state };
  }
  const id = asString(raw.id);
  if (!id) return { record: null, state: sanitizer.state };

  const record = {
    id,
    role: asString(raw.role) || "unknown",
    createdAt: asString(raw.createdAt) || null,
    content: sanitizer.text("content", raw.content) ?? "",
  };

  const optionalText = (target, field, value) => {
    const out = sanitizer.text(field, value);
    if (out !== undefined) target[field] = out;
  };

  optionalText(record, "thinking", raw.thinking);
  optionalText(record, "status", raw.status);
  optionalText(record, "command", raw.command);
  optionalText(record, "modelId", raw.modelId);
  optionalText(record, "providerId", raw.providerId);
  optionalText(record, "toolName", raw.toolName);
  optionalText(record, "toolCallId", raw.toolCallId);
  optionalText(record, "toolStatus", raw.toolStatus);
  optionalText(record, "toolCompletedAt", raw.toolCompletedAt);
  optionalText(record, "parentToolCallId", raw.parentToolCallId);
  optionalText(record, "agentName", raw.agentName);

  const usage = normalizeUsage(raw.usage);
  if (usage) record.usage = usage;
  const responseDurationMs = asNumberOrNull(raw.responseDurationMs);
  if (responseDurationMs !== null) record.responseDurationMs = responseDurationMs;
  const responseOutputTokens = asNumberOrNull(raw.responseOutputTokens);
  if (responseOutputTokens !== null) record.responseOutputTokens = responseOutputTokens;
  const toolDurationMs = asNumberOrNull(raw.toolDurationMs);
  if (toolDurationMs !== null) record.toolDurationMs = toolDurationMs;
  if (raw.isError === true || raw.status === "error") record.isError = true;
  if (raw.steering === true) record.steering = true;

  const attachments = normalizeAttachments(raw.attachments, sanitizer);
  if (attachments) record.attachments = attachments;

  if (options.includeToolPayloads !== false) {
    // `deep` already bounds depth, collection size and every string inside.
    if (raw.toolArgs !== undefined && raw.toolArgs !== null) {
      record.toolArgs = sanitizer.deep("toolArgs", raw.toolArgs);
    }
    if (raw.toolResult !== undefined && raw.toolResult !== null) {
      record.toolResult = sanitizer.deep("toolResult", raw.toolResult);
    }
  } else if (record.toolName) {
    record.toolPayloadsOmitted = true;
  }

  if (raw.error !== undefined && raw.error !== null) {
    record.error = sanitizer.deep("error", raw.error);
  }

  return { record, state: sanitizer.state };
}

/** Normalize a host session summary (also used for the flattened detail head). */
function normalizeSessionSummary(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = asString(raw.id);
  if (!id) return null;
  return {
    id,
    title: asString(raw.title) || null,
    messageCount: asNumberOrNull(raw.messageCount),
    projectPath: asString(raw.projectPath) || null,
    projectId: asNumberOrNull(raw.projectId),
    modelId: asString(raw.modelId) || null,
    providerId: asString(raw.providerId) || null,
    mode: asString(raw.mode) || null,
    thinkingLevel: asString(raw.thinkingLevel) || null,
    permissionMode: asString(raw.permissionMode) || null,
    source: asString(raw.source) || null,
    createdAt: asString(raw.createdAt) || null,
    updatedAt: asString(raw.updatedAt) || null,
  };
}

/**
 * Unwrap a host `session/get` reply. Tolerates the shapes this host and older
 * builds may return, because a wrong guess here would silently archive nothing.
 */
function extractSessionDetail(payload) {
  let session = payload;
  if (payload && typeof payload === "object" && payload.session && typeof payload.session === "object") {
    session = payload.session;
  }
  if (!session || typeof session !== "object") return null;
  const messages = Array.isArray(session.messages)
    ? session.messages
    : Array.isArray(session.transcript)
      ? session.transcript
      : [];
  return {
    summary: normalizeSessionSummary(session),
    messages,
    messageStart: asNumberOrNull(session.messageStart),
    messageEnd: asNumberOrNull(session.messageEnd),
    hasMoreBefore: session.hasMoreBefore === true,
    hasMoreAfter: session.hasMoreAfter === true,
    compactions: Array.isArray(session.compactions) ? session.compactions : [],
    compaction: session.compaction ?? null,
  };
}

/** Pull a session array out of a host `session/list` reply. */
function extractSessionList(payload) {
  const raw = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray(payload.sessions)
      ? payload.sessions
      : [];
  return raw.map(normalizeSessionSummary).filter(Boolean);
}

/**
 * Decide whether one session needs work.
 *
 * The host `messageCount` is the canonical transcript's logical length, so it
 * drives the append path; `updatedAt` alone still triggers a metadata refresh,
 * because a rename or a model change must land in the archive too.
 */
function planSync(summary, checkpoint) {
  if (!summary) return { needed: false, mode: "skip", reason: "no-summary" };
  if (!checkpoint || !checkpoint.sessionId) {
    return { needed: true, mode: "full", reason: "not-archived" };
  }
  if (checkpoint.sessionId !== summary.id) {
    // Never append into another session's file, whatever the caller passed.
    return { needed: true, mode: "full", reason: "id-mismatch" };
  }
  const stored = Number.isFinite(checkpoint.storedMessages) ? checkpoint.storedMessages : 0;
  const total = Number.isFinite(summary.messageCount) ? summary.messageCount : null;
  if (total !== null && total > stored) {
    return { needed: true, mode: "incremental", reason: "new-messages" };
  }
  if (total !== null && total < stored) {
    // A rewritten or forked transcript: the archive must not keep a longer
    // history than the host still serves.
    return { needed: true, mode: "full", reason: "transcript-shrank" };
  }
  if (summary.updatedAt && checkpoint.updatedAt && summary.updatedAt !== checkpoint.updatedAt) {
    return { needed: true, mode: "incremental", reason: "metadata-changed" };
  }
  if (!checkpoint.updatedAt && summary.updatedAt) {
    return { needed: true, mode: "incremental", reason: "no-checkpoint-time" };
  }
  return { needed: false, mode: "skip", reason: "up-to-date" };
}

/**
 * Plan the next `session/get` window.
 *
 * Confirmed host semantics: `messageBefore` is an exclusive end coordinate
 * counted from the start of the physical transcript, and omitting it reads the
 * newest window. So the first request sends no cursor, and every later request
 * walks backwards from the returned `messageStart`.
 */
function nextWindowRequest(sessionId, cursor, pageSize, fetched, maxMessages) {
  const size = clampInt(pageSize, 1, 500, 200);
  const cap = Number.isFinite(maxMessages) && maxMessages > 0 ? Math.floor(maxMessages) : Infinity;
  if (fetched >= cap) return null;
  const request = { id: sessionId, messageLimit: Math.min(size, cap - fetched) };
  if (Number.isFinite(cursor)) request.messageBefore = Math.max(0, Math.floor(cursor));
  return request;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * Merge fetched records into the stored ones.
 *
 * Dedupe keeps the last occurrence of an id, matching the host's own transcript
 * rule (a retried append leaves two lines with one id). Order is by `createdAt`
 * and then by first appearance, so paging backwards still produces an ascending
 * transcript. The cap drops the oldest records and reports how many.
 */
function mergeMessages(existing, incoming, options = {}) {
  const cap = Number.isFinite(options.maxMessagesPerSession) && options.maxMessagesPerSession > 0
    ? Math.floor(options.maxMessagesPerSession)
    : Infinity;
  const order = new Map();
  const byId = new Map();
  let sequence = 0;

  const add = (record) => {
    if (!record || !record.id) return;
    if (!order.has(record.id)) order.set(record.id, sequence++);
    byId.set(record.id, record); // last write wins
  };
  for (const record of existing ?? []) add(record);
  for (const record of incoming ?? []) add(record);

  const merged = [...byId.values()].sort((a, b) => {
    const left = asString(a.createdAt);
    const right = asString(b.createdAt);
    if (left && right && left !== right) return left < right ? -1 : 1;
    if (left && !right) return -1;
    if (!left && right) return 1;
    return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
  });

  const dropped = merged.length > cap ? merged.length - cap : 0;
  return {
    messages: dropped > 0 ? merged.slice(dropped) : merged,
    added: incoming?.length ?? 0,
    dropped,
  };
}

/** File name for one session archive; ids are opaque but must stay path-safe. */
function safeFileName(sessionId) {
  const cleaned = asString(sessionId)
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, 120);
  return cleaned || "session";
}

function toJsonl(records) {
  const lines = [];
  for (const record of records ?? []) {
    if (!record) continue;
    lines.push(JSON.stringify(record));
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

function yamlish(value) {
  const text = asString(value);
  if (!text) return "null";
  return /[:#\-?[\]{}",&*!|>%@`]/.test(text) || /^\s|\s$/.test(text)
    ? JSON.stringify(text)
    : text;
}

function toMarkdown(detail) {
  const { summary = {}, messages = [], meta = {} } = detail ?? {};
  const lines = [
    `# ${asString(summary.title) || asString(summary.id) || "Session"}`,
    "",
    `- sessionId: ${yamlish(summary.id)}`,
    `- createdAt: ${yamlish(summary.createdAt)}`,
    `- updatedAt: ${yamlish(summary.updatedAt)}`,
    `- messages: ${messages.length}`,
    `- model: ${yamlish(summary.modelId)}`,
    `- provider: ${yamlish(summary.providerId)}`,
  ];
  if (meta.exportedAt) lines.push(`- exportedAt: ${meta.exportedAt}`);
  if (meta.truncatedFields?.length) {
    lines.push(`- truncated fields: ${meta.truncatedFields.join(", ")}`);
  }
  if (meta.incomplete) lines.push("- note: archive is incomplete; see the gap records");
  lines.push("", "---", "");

  for (const message of messages) {
    const role = asString(message.role) || "unknown";
    const stamp = asString(message.createdAt) || "";
    const heading = message.toolName ? `${role} · ${message.toolName}` : role;
    lines.push(`## ${heading}${stamp ? ` — ${stamp}` : ""}`);
    if (message.toolStatus) lines.push(`_status: ${yamlish(message.toolStatus)}_`);
    if (message.agentName) lines.push(`_subagent: ${yamlish(message.agentName)}_`);
    if (message.modelId) lines.push(`_model: ${yamlish(message.modelId)}_`);
    lines.push("");
    if (message.thinking) {
      lines.push("<details><summary>thinking</summary>", "", "```text", message.thinking, "```", "", "</details>", "");
    }
    if (message.content) lines.push(message.content, "");
    if (message.toolArgs !== undefined) {
      lines.push("**arguments**", "", "```json", stringifyBounded(message.toolArgs), "```", "");
    }
    if (message.toolResult !== undefined) {
      lines.push("**result**", "", "```json", stringifyBounded(message.toolResult), "```", "");
    }
    if (message.error !== undefined) {
      lines.push("**error**", "", "```json", stringifyBounded(message.error), "```", "");
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function stringifyBounded(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Aggregate counters for the panel header and one archive row. */
function summarizeArchive(records) {
  let messages = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let redactions = 0;
  let gaps = 0;
  const truncatedFields = new Set();
  let firstAt = null;
  let lastAt = null;

  for (const record of records ?? []) {
    if (!record || typeof record !== "object") continue;
    if (record.type === "message") {
      messages += 1;
      if (record.role === "user") userMessages += 1;
      if (record.role === "assistant") assistantMessages += 1;
      if (record.toolName) toolCalls += 1;
      if (record.isError) toolErrors += 1;
      redactions += Number.isFinite(record.redactions) ? record.redactions : 0;
      for (const field of Object.keys(record.truncations ?? {})) truncatedFields.add(field);
      const at = asString(record.createdAt);
      if (at) {
        if (!firstAt || at < firstAt) firstAt = at;
        if (!lastAt || at > lastAt) lastAt = at;
      }
    } else if (record.type === "gap") {
      gaps += 1;
    }
  }
  return {
    messages,
    userMessages,
    assistantMessages,
    toolCalls,
    toolErrors,
    redactions,
    gaps,
    truncatedFields: [...truncatedFields].sort(),
    firstAt,
    lastAt,
  };
}

/** Case-insensitive search over archived session files, used by the agent tool. */
function searchArchive(sessions, query, options = {}) {
  const needle = asString(query).trim().toLowerCase();
  const excerptChars = clampInt(options.excerptChars, 40, 2000, 240);
  const limit = clampInt(options.limit, 1, 50, 10);
  const hits = [];

  for (const session of sessions ?? []) {
    const haystackTitle = asString(session.summary?.title).toLowerCase();
    const matched = [];
    if (!needle) {
      // No query: report the newest sessions with their first user message, so
      // the agent can orient without pulling any full transcript.
      const firstUser = (session.messages ?? []).find((m) => m.role === "user" && m.content);
      if (firstUser) {
        matched.push({ messageId: firstUser.id, role: "user", excerpt: excerpt(firstUser.content, excerptChars) });
      }
    } else {
      for (const message of session.messages ?? []) {
        const content = asString(message.content);
        const index = content.toLowerCase().indexOf(needle);
        if (index === -1) continue;
        matched.push({
          messageId: message.id,
          role: message.role,
          at: message.createdAt ?? null,
          excerpt: excerpt(content.slice(Math.max(0, index - Math.floor(excerptChars / 2))), excerptChars),
        });
        if (matched.length >= 5) break;
      }
    }
    if (!matched.length) continue;
    hits.push({
      sessionId: session.summary?.id ?? null,
      title: session.summary?.title ?? null,
      updatedAt: session.summary?.updatedAt ?? null,
      reason: needle ? (haystackTitle.includes(needle) ? "title-and-content" : "content") : "recent",
      matches: matched,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

function excerpt(text, max) {
  const normalized = asString(text).replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}…`;
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

module.exports = {
  SCHEMA_VERSION,
  REDACTED,
  clampInt,
  createSanitizer,
  excerpt,
  extractSessionDetail,
  extractSessionList,
  formatBytes,
  isSecretKey,
  mergeMessages,
  nextWindowRequest,
  normalizeMessage,
  normalizeSessionSummary,
  normalizeCompaction,
  planSync,
  redactText,
  safeFileName,
  searchArchive,
  summarizeArchive,
  toJsonl,
  toMarkdown,
};
