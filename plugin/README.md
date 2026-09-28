# Session Recorder

A local-first recorder for PI-Desktop: it archives every conversation and tool call of this device
into per-session JSONL files, marks what is missing or truncated instead of hiding it, and exports a
session as JSONL or Markdown. Nothing leaves the machine.

本地会话记录器：把本机每次对话与工具调用增量归档为按会话分文件的 JSONL，**显式标注缺失与截断**，
并把任意会话导出为 JSONL / Markdown。不联网、不上报，数据只在本机。

## What it does

- **Incremental archive** — reads the local transcripts through reviewed host operations
  (`session/list`, `session/get`) and appends only what is new; a rewritten or shorter transcript
  starts a new epoch instead of keeping stale history.
- **Readable viewer** — the panel decodes tool output into readable text (stdout, stderr, nested
  `content[]` envelopes, payload bodies kept in a `content` string) and keeps the exact stored bytes
  one disclosure away under “原始 JSON”.
- **Honest gaps** — truncation, dropped-oldest caps, fetch errors and incomplete windows are recorded
  as gaps and shown as chips/notes, never silently.
- **Secret masking on the way to disk** — token/key/password/authorization/cookie/credential-shaped
  fields and Bearer/JWT/connection-string credentials are masked before they are written.
- **Export** — JSONL (machine) and Markdown (reading) per session.
- **Agent tool** — a bounded, read-only search over the archive this plugin already holds.

## Requirements

| Field | Value |
|---|---|
| PI-Desktop | `>=0.14.6` (the desktop control plane used for session reads ships from 0.14.6) |
| Panel | `renderer/index.html`, 1180 × 820 |
| Network | none — the plugin makes no requests and installs nothing |

## Command

| Command id | Title | What it does |
|---|---|---|
| `session-recorder.open` | 会话记录器：打开 / Session Recorder: Open | Opens the panel. The title follows the application language; the panel uses the host's 46px drag band and window-control capsule. |

## Settings

| Key | Type | Default | Meaning |
|---|---|---|---|
| `autoSync` | boolean | `true` | Archive sessions in the background while the plugin is running. Off = manual only. |
| `intervalMinutes` | number | `5` | Background interval, 1–240 minutes. Shorter is fresher and writes more often. |
| `redactSecrets` | boolean | `true` | Mask secret-shaped fields and credentials before writing. Turning this off writes plaintext and is not recommended. |
| `includeToolPayloads` | boolean | `true` | Record tool arguments and results. Off keeps only tool name, status and duration (much smaller archive). |
| `pageSize` | number | `200` | Messages requested from the host per call, 1–500 (500 is the host's own limit). |
| `maxMessagesPerSession` | number | `20000` | Keep at most this many messages per session; older ones are dropped and recorded as a `dropped-oldest` gap. |
| `maxContentChars` | number | `20000` | Per long text field. Longer content is truncated and the original length is recorded; the panel shows a “截断” chip. |
| `maxArchiveMb` | number | `512` | Soft size budget in MB. Exceeding it only warns in the panel; no file is ever deleted automatically. |

## Agent tool

Registered name: `session_archive_query` (the host exposes it prefixed as
`plugin_<plugin-id-safe>_session_archive_query`). Risk: **low**.

| Input | Type | Default | Limits |
|---|---|---|---|
| `query` | string | empty | Case-insensitive substring. Empty lists the newest sessions. |
| `sessionId` | string | — | Restrict to one archived session. |
| `limit` | number | 10 | Max 50. |
| `excerptChars` | number | 240 | Max 2000 characters per hit. |

Returns session metadata plus bounded text excerpts from **this plugin's own archive**. It cannot
read the host database, the live transcript files, any other plugin's data, or the network.

## Permissions

| Permission | Why it is needed | Boundary |
|---|---|---|
| `ui.panel` | The viewer/export panel. | Panel is isolated; it talks to the plugin process through the host bridge only. |
| `desktop.control` | Session reads via `session/list` + `session/get`. | **Read-only**, two reviewed operations, no other desktop operation is called; the host database and transcript files are never written. |
| `background.service` | The periodic archive pass (`services.sync`). | Runs only while PI-Desktop runs; turning off `autoSync` stops it. |
| `agent.tool.register` | The `session_archive_query` tool above. | Requires an explicit user grant; the tool is read-only and bounded. |

## Data, storage and privacy

- Location: this plugin's own data directory — `<appData>/plugins/data/com.github.yy568821795-max.session-recorder/`
  (`archive/index.json`, `archive/sessions/<sessionId>.jsonl`, `exports/`, `recorder.log`).
- The archive is plain JSONL so it stays readable and greppable outside the app.
- **Content can contain source code or personal data.** Masking is on by default; a session or the
  whole archive can be deleted from the panel at any time; the plugin never uploads anything.
- Truncation and gaps are recorded per session (`truncatedFields`, `problems`) and surfaced in the UI.
- Agent tool output is a bounded excerpt, not a full transcript dump.

## Export

From the panel: **导出 Markdown** / **导出 JSONL** / **两种格式** writes into the plugin data
directory (`exports/<sessionId>-<timestamp>.{md,jsonl}`). Exported files are masked the same way the
archive is.

## Troubleshooting

| Symptom | Meaning |
|---|---|
| 面板提示「本地归档不完整」 | A fetch failed, the transcript window was incomplete, or the message cap dropped oldest entries. The reason is listed on the session. |
| 某一行显示「截断 …」 | That field exceeded `maxContentChars`; raise the setting for future syncs (already-archived messages keep their recorded cut). |
| 搜索不到某次对话 | Only sessions this plugin has archived are searchable; run 立即同步 first. |

## License

MIT — see [LICENSE](./LICENSE).
