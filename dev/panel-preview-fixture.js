/*
 * Preview fixture: a stubbed `window.pluginBridge` plus hostile sample data.
 *
 * Loaded only by test/panel-preview.html (a development harness). It lets the
 * real panel.css + panel.js render in a plain browser, with no PI-Desktop and
 * no archive on disk.
 *
 * The fixture is deliberately nasty, because these are the shapes that made the
 * first version of the panel unreadable:
 *   - a raw host envelope whose inner text is JSON again
 *   - a multi-kilobyte command dump with escaped CRLF
 *   - a 2,000-character assistant message (tests the line clamp)

 *   - a 150-character session title (tests list truncation)
 *   - a failed tool call, an incomplete archive, a redaction counter
 */

(function () {
  "use strict";

  /*
   * The host injects its own design tokens into a plugin page; a plain browser
   * does not. These are the real values from PI-Desktop's tokens.css (gray ramp
   * 0/100/300/750/800/1000, light + dark), so the harness renders with the same
   * palette the app does instead of falling through to the panel's fallbacks.
   *
   * That matters: the app's accent is monochrome (ink in light, white in dark),
   * which is exactly the combination a hardcoded blue accent would break.
   */
  const HOST_TOKENS = {
    light: {
      "--ds-bg-primary": "#ffffff",
      "--ds-bg-secondary": "#f9f9f9",
      "--ds-bg-tertiary": "#f3f3f3",
      "--ds-bg-inset": "#ededed",
      "--ds-bg-hover": "color-mix(in oklab, #1a1c1f 5%, transparent)",
      "--ds-bg-active": "color-mix(in oklab, #1a1c1f 8%, transparent)",
      "--ds-bg-chip": "color-mix(in oklab, #1a1c1f 4%, transparent)",
      "--ds-text-primary": "#1a1c1f",
      "--ds-text-secondary": "color-mix(in oklab, #1a1c1f 74%, transparent)",
      "--ds-text-muted": "#5d5d5d",
      "--ds-text-faint": "#afafaf",
      "--ds-border-subtle": "color-mix(in oklab, #1a1c1f 5%, transparent)",
      "--ds-border-strong": "color-mix(in oklab, #1a1c1f 12%, transparent)",
      "--ds-accent": "#1a1c1f",
      "--ds-accent-hover": "#303030",
      "--ds-tool-row-bg": "color-mix(in oklab, #1a1c1f 2%, transparent)",
      "--ds-success": "#00a240",
      "--ds-warning": "#e25507",
      "--ds-error": "#e02e2a",
      "--ds-field-height": "28px",
    },
    dark: {
      "--ds-bg-primary": "#161616",
      "--ds-bg-secondary": "#212121",
      "--ds-bg-tertiary": "#282828",
      "--ds-bg-inset": "#0d0d0d",
      "--ds-bg-hover": "color-mix(in oklab, #ffffff 6%, transparent)",
      "--ds-bg-active": "color-mix(in oklab, #ffffff 10%, transparent)",
      "--ds-bg-chip": "color-mix(in oklab, #ffffff 6%, transparent)",
      "--ds-text-primary": "#ffffff",
      "--ds-text-secondary": "color-mix(in oklab, #ffffff 70%, transparent)",
      "--ds-text-muted": "color-mix(in oklab, #ffffff 52%, transparent)",
      "--ds-text-faint": "color-mix(in oklab, #ffffff 38%, transparent)",
      "--ds-border-subtle": "color-mix(in oklab, #ffffff 5%, transparent)",
      "--ds-border-strong": "color-mix(in oklab, #ffffff 14%, transparent)",
      "--ds-accent": "#ffffff",
      "--ds-accent-hover": "#ededed",
      "--ds-tool-row-bg": "color-mix(in oklab, #ffffff 3.5%, transparent)",
      "--ds-success": "#40c977",
      "--ds-warning": "#ff8549",
      "--ds-error": "#ff6764",
      "--ds-field-height": "28px",
    },
  };

  /** Apply one host palette to :root; also mirror the app's theme attribute. */
  window.__srSetTheme = function setTheme(mode) {
    const tokens = HOST_TOKENS[mode] || HOST_TOKENS.light;
    const root = document.documentElement;
    for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
    root.setAttribute("data-theme", mode);
    root.style.colorScheme = mode;
    return mode;
  };
  window.__srSetTheme("light");
  const PAD = (n) => String(n).padStart(2, "0");

  /** The exact shape the runtime stores for a shell tool result. */
  function shellEnvelope(exitCode, stdout) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              commandShellId: "windows-powershell",
              exitCode,
              stderr: exitCode === 0 ? "" : "fatal: unable to access 'https://github.com/': Recv failure",
              stdout: stdout.replace(/\r?\n/g, "\\n"),
            },
            null,
            2,
          ),
        },
      ],
      details: { commandShellId: "windows-powershell", exitCode },
      truncated: false,
      isError: exitCode !== 0,
    };
  }

  /**
   * The shape a bounded field is stored in: the text cut at `keep` characters,
   * then the recorder's own marker. A cut that lands inside a JSON string is
   * what used to make a truncated tool row render as an escaped blob.
   */
  function cutByBound(text, keep) {
    return `${text.slice(0, keep)}\n…[truncated ${text.length - keep} chars]`;
  }

  const LONG_TITLE =
    "看看https://github.com/vastsa/PI-Desktop这个项目里面的插件市场的原理是什么里面的所有插件来自于哪里呢 跟pi-agent官方的扩展是什么关系呢";

  const LONG_ANSWER = [
    "我先核对项目源码和插件清单，重点看插件来源、与 pi-agent 扩展的关系，以及对话详情的获取方式。",
    "",
    "### 1. 市场原理",
    "它是「插件目录 + 安装包分发 + 本地插件运行环境」三层。客户端读取 catalog.json，安装时向插件中心查询下载地址，下载 .piplug 后核验 SHA-256 与大小，再交给宿主做清单校验与权限审查。",
    "",
    "### 2. 插件来源",
    "现有 40 个条目里，27 个在首个版本中带有 provenance.sourceRepository，其余条目的源码归属无法仅凭目录完整追溯。官方渠道 ≠ 全部官方开发。",
    "",
    "### 3. 与 pi 扩展的关系",
    "复用 pi 的内核（pi-ai / pi-agent-core / pi-coding-agent 0.87.1）与 ExtensionAPI 契约，但桌面端实现了其中一个显式子集；会话历史相关的访问器存在空实现。",
  ].join("\n") + `\n${"（这段文字用于验证长正文的折叠与展开：面板默认只显示 14 行，其余内容需要显式展开。）\n".repeat(12)}`;

  function message(index, overrides) {
    const minute = index % 60;
    return {
      id: `m${String(index).padStart(3, "0")}`,
      role: "assistant",
      createdAt: `2026-09-28T14:${PAD(minute)}:${PAD((index * 7) % 60)}.000Z`,
      content: "",
      ...overrides,
    };
  }

  const messages = [
    message(0, {
      role: "user",
      content:
        "看看https://github.com/vastsa/PI-Desktop这个项目里面的插件市场的原理是什么？里面的所有插件来自于哪里呢？跟 pi-agent 官方的扩展是什么关系呢？还有就是我想获取每次对话的详情，有无对应的插件市场或者扩展呢？",
    }),
    message(1, { content: LONG_ANSWER, thinking: "先确认目录来源，再看扩展适配层。注意区分官方渠道与官方开发。" }),
    message(2, {
      role: "tool",
      toolName: "Bash",
      toolStatus: "success",
      toolDurationMs: 1732,
      content:
        '{"commandShellId":"windows-powershell","exitCode":0,"stderr":"","stdout":"D:\\\\work_space\\\\java_work_space\\\\public_utils\\\\norigin\\\\thttps://gitee.com/hatricks/public_utils.git (fetch)","details":{"exitCode":0},"truncated":false}',
      toolArgs: { command: "git remote -v; git status --short" },
      toolResult: shellEnvelope(
        0,
        [
          "D:\\work_space\\java_work_space\\public_utils",
          "origin  https://gitee.com/hatricks/public_utils.git (fetch)",
          "origin  https://gitee.com/hatricks/public_utils.git (push)",
          "A  tang-seng-wedding-offline.html",
          "?? tang-seng-nverguo-wedding.html",
          "?? tang-seng-wedding-svg.html",
          "2026-09-28",
        ].join("\n"),
      ),
    }),
    message(3, { content: "GitHub 克隆连接被重置，我改用 API 和源码文件读取。" }),
    message(4, {
      role: "tool",
      toolName: "Bash",
      toolStatus: "error",
      toolDurationMs: 21504,
      isError: true,
      content: '{"exitCode":128,"stderr":"Cloning into ... fatal: unable to access","stdout":""}',
      toolArgs: { command: 'git clone https://github.com/vastsa/PI-Desktop.git "$env:PI_SCRATCH_DIR\\PI-Desktop"' },
      toolResult: shellEnvelope(128, ""),
      error: { code: "EXIT_128", message: "Command failed with exit code 128" },
    }),
    message(5, { content: "已取得 v0.15.10 源码。我会分开核对「市场插件」和「底层扩展」，这两者不能直接等同。" }),
    message(6, {
      role: "tool",
      toolName: "Read",
      toolStatus: "success",
      toolDurationMs: 41,
      toolArgs: { file_path: "docs/spec/07-plugins/03-plugin-api.md", offset: 295, limit: 180 },
      toolResult: {
        content: [{ type: "text", text: "### session (requires `session.read`)\n\n```ts\npi.session.getLlmContext(): Promise<PluginLlmContext>\n```" }],
      },
    }),
    message(7, { content: "源码显示已经有「导入 pi 扩展」的适配层；我再确认它的权限边界和对话数据能力。" }),
    message(8, {
      role: "tool",
      toolName: "Grep",
      toolStatus: "success",
      toolDurationMs: 12,
      toolArgs: { pattern: "sessions.read|transcript|getEntries", path: "packages/agent-runtime" },
      toolResult: {
        content: [{ type: "text", text: "runner.ts:709:      getEntries: () => [],\nrunner.ts:710:      getBranch: () => []," }],
      },
    }),
    message(9, {
      content:
        "这些访问器是空实现，说明依赖 sessionManager.getEntries() 的 pi 扩展在桌面端会拿到空数组。这一点会写进结论。",
      status: "completed",
      modelId: "deepseek-flash",
      usage: { inputTokens: 18420, outputTokens: 733, totalTokens: 19153 },
    }),
    // The exact shape that still rendered as an escaped blob: a tool row whose
    // `content` IS the envelope (as a JSON string), with no separate
    // `toolResult`. The inner text is JSON again, and its stdout is a ripgrep
    // dump — three levels of wrapping.
    message(10, {
      role: "tool",
      toolName: "Bash",
      toolStatus: "success",
      toolDurationMs: 88,
      content: JSON.stringify({
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                commandShellId: "windows-powershell",
                exitCode: 0,
                stderr: "",
                stdout: [
                  'apps/desktop/electron/main/mcp-control.ts:209:   spec("sessionList", "session/list", "List durable sessions.", "read", []),',
                  'apps/desktop/electron/main/mcp-control.ts:212:   spec("sessionGet", "session/get", "Read a session and its transcript.", "read", ["input"]),',
                  'apps/desktop/electron/main/mcp-control.ts:218:   spec("sessionListRevisions", "session/listRevisions", "List transcript revisions.", "read", ["input"]),',
                  'apps/desktop/electron/main/mcp-control.ts:301: coreTool("pi_session_list", "List durable sessions.", objectSchema({}), "session/list", () => []),',
                  'apps/desktop/electron/main/remote/remote-backend.ts:121:     const { session } = await client.request<{ session: RacpSession }>("session/get", {',
                ].join("\n"),
              },
              null,
              2,
            ),
          },
        ],
        details: { commandShellId: "windows-powershell", exitCode: 0 },
        truncated: false,
      }),
      toolArgs: { command: 'rg -n "session/list|session/get" apps/desktop/electron/main' },
    }),
    // The stored shape after the size bound bit: the envelope is cut inside its
    // nested stdout string and the recorder's marker replaces the tail, exactly
    // as `lib/recorder-core.js` writes it. The row only reads as command output
    // if the decoder re-closes the cut document.
    (() => {
      const stdout = Array.from({ length: 60 }, (_, index) => `line ${index} of catalog output`).join("\n");
      const inner = JSON.stringify({
        commandShellId: "windows-powershell",
        exitCode: 0,
        stderr: "",
        stdout,
      });
      const envelope = JSON.stringify({
        content: [{ type: "text", text: inner }],
        details: { commandShellId: "windows-powershell", exitCode: 0 },
        isError: false,
      });
      const keep = (text) => text.indexOf('"stdout"') + 320;
      return message(11, {
        role: "tool",
        toolName: "Bash",
        toolStatus: "success",
        toolDurationMs: 640,
        content: cutByBound(envelope, keep(envelope)),
        toolArgs: { command: "node scripts/catalog-report.mjs" },
        toolResult: {
          content: [{ type: "text", text: cutByBound(inner, keep(inner)) }],
          details: { commandShellId: "windows-powershell", exitCode: 0 },
          isError: false,
        },
      });
    })(),
    // A payload whose body lives in `content` as a plain string (`Read` keeps
    // the file text there), so the wrapper must not become the body.
    message(12, {
      role: "tool",
      toolName: "Read",
      toolStatus: "success",
      toolDurationMs: 210,
      content: JSON.stringify({
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                content:
                  "[D:\\work_space\\pi-session-recorder\\lib\\archive-store.js#CF35]\n195:    const row = index.sessions[sessionId];\n196:    if (!row) return null;",
                fileBytes: 9810,
                lineCount: 240,
                offset: 194,
                path: "D:\\work_space\\pi-session-recorder\\lib\\archive-store.js",
                root: "external",
                tag: "CF35",
                totalLines: 288,
                truncated: false,
              },
              null,
              2,
            ),
          },
        ],
        details: { path: "D:\\work_space\\pi-session-recorder\\lib\\archive-store.js" },
        isError: false,
      }),
      toolArgs: { path: "D:\\work_space\\pi-session-recorder\\lib\\archive-store.js", offset: 194 },
    }),
    // The envelope shape again, one level down: the inner text is itself a
    // result object with a `content` block array.
    message(13, {
      role: "tool",
      toolName: "mcp_list_pages",
      toolStatus: "success",
      toolDurationMs: 180,
      content: JSON.stringify({
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                content: [{ text: "## Pages\n1: 会话记录器 (file:///D:/preview.html) [selected]", type: "text" }],
                details: {},
              },
              null,
              2,
            ),
          },
        ],
        details: {},
        isError: false,
      }),
      toolArgs: {},
    }),
    // The size bound cut this envelope part way through a token (`…"tags":`),
    // so ending the string and closing the containers is not enough: the
    // half-written tail has to go.
    (() => {
      const inner = JSON.stringify(
        {
          count: 2,
          files: 1,
          matches: [
            { line: 577, path: "packages/agent-runtime/src/sidecar.ts", text: 'stderr.write("first match");' },
            { line: 612, path: "packages/agent-runtime/src/sidecar.ts", text: 'stderr.write("second match");' },
          ],
          tags: { "packages/agent-runtime/src/sidecar.ts": ["stderr"] },
        },
        null,
        2,
      );
      const envelope = JSON.stringify({
        content: [{ type: "text", text: inner }],
        details: { exitCode: 0, commandShellId: "windows-powershell" },
        isError: false,
      });
      return message(14, {
        role: "tool",
        toolName: "Grep",
        toolStatus: "success",
        toolDurationMs: 320,
        // The inner JSON's quotes are escaped inside the envelope, so the cut is
        // placed by the bare key text: it lands inside `"tags`, i.e. mid-token.
        content: cutByBound(envelope, envelope.indexOf("tags") + 6),
        toolArgs: { pattern: "stderr.write" },
      });
    })(),
  ];

  const ARCHIVE_LONG = {
    sessionId: "8f2c1d4e-6a7b-4c8d-9e0f-1a2b3c4d5e6f",
    title: LONG_TITLE,
    storedMessages: 240,
    updatedAt: "2026-09-28T14:25:48.065Z",
    lastSyncAt: "2026-09-28T14:26:02.114Z",
    lastSyncMode: "incremental",
    incomplete: false,
    problems: [],
    redactions: 3,
    truncatedFields: ["content"],
    bytes: 2097152,
    bytesLabel: "2.0 MB",
    pages: 2,
  };

  const ARCHIVE_PARTIAL = {
    sessionId: "0b0e9c11-2222-4333-8444-555566667777",
    title: "排查 Kafka 消费延迟与 hash 不一致",
    storedMessages: 88,
    updatedAt: "2026-09-27T09:12:04.000Z",
    lastSyncAt: "2026-09-28T14:26:02.114Z",
    lastSyncMode: "incremental",
    incomplete: true,
    problems: ["fetch-error: connection reset"],
    redactions: 0,
    truncatedFields: [],
    bytes: 318000,
    bytesLabel: "310.5 KB",
    pages: 1,
  };

  const ARCHIVE_SMALL = {
    sessionId: "77aa33bb-1100-4d55-9e22-aa11bb22cc33",
    title: "weekly report",
    storedMessages: 6,
    updatedAt: "2026-09-25T18:02:00.000Z",
    lastSyncAt: "2026-09-28T14:26:02.114Z",
    lastSyncMode: "full",
    incomplete: false,
    problems: [],
    redactions: 1,
    truncatedFields: [],
    bytes: 9210,
    bytesLabel: "9.0 KB",
    pages: 1,
  };

  const STATUS = {
    ok: true,
    pluginId: "local.session-recorder",
    storage: { root: "C:\\Users\\me\\.pi-desktop\\plugins\\data\\local.session-recorder\\archive" },
    settings: { autoSync: true, intervalMinutes: 5, redactSecrets: true },
    totals: {
      sessions: 3,
      messages: 334,
      bytes: 2424380,
      bytesLabel: "2.3 MB",
      budgetLabel: "512 MB",
      overBudget: false,
    },
    running: false,
    lastRunAt: "2026-09-28T14:26:02.114Z",
    lastResult: { listed: 3, synced: 1, skipped: 2, partial: 1, failed: 0 },
    lastError: null,
    logTail: [
      "2026-09-28T14:26:02.101Z synced 8f2c1d4e: mode=incremental appended=2 stored=240",
      "2026-09-28T14:26:02.110Z synced 0b0e9c11: mode=incremental appended=0 stored=88 problems=fetch-error: connection reset",
      "2026-09-28T14:26:02.113Z synced 77aa33bb: skipped (up-to-date)",
    ],
  };

  window.pluginBridge = {
    async invoke(channel, payload) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      switch (String(channel)) {
        case "recorder.list":
          return { ok: true, archives: [ARCHIVE_LONG, ARCHIVE_PARTIAL, ARCHIVE_SMALL], status: STATUS };
        case "recorder.status":
          return STATUS;
        case "recorder.get": {
          const id = payload && payload.sessionId;
          const archive = [ARCHIVE_LONG, ARCHIVE_PARTIAL, ARCHIVE_SMALL].find((row) => row.sessionId === id);
          const isLong = archive === ARCHIVE_LONG;
          return {
            ok: true,
            sessionId: id,
            header: {
              id,
              title: archive ? archive.title : id,
              modelId: isLong ? "deepseek-flash" : "claude-sonnet-4",
              mode: "agent",
              createdAt: "2026-09-28T14:04:10.918Z",
            },
            stats: {
              messages: isLong ? messages.length : 2,
              userMessages: isLong ? 5 : 1,
              assistantMessages: isLong ? 4 : 1,
              toolCalls: isLong ? 3 : 0,
              toolErrors: isLong ? 1 : 0,
              redactions: archive ? archive.redactions : 0,
              truncatedFields: archive ? archive.truncatedFields : [],
              firstAt: "2026-09-28T14:04:10.918Z",
              lastAt: "2026-09-28T14:25:48.065Z",
            },
            checkpoint: archive,
            messages: isLong
              ? messages
              : [
                  message(0, { role: "user", content: "把上周的周报要点整理一下。" }),
                  message(1, { content: "已完成：三条线上问题关闭，两条进入观察期。" }),
                ],
            gaps: archive && archive.incomplete ? [{ at: "2026-09-28T14:26:02.110Z", reason: "fetch-error: connection reset" }] : [],
            syncs: [{ at: "2026-09-28T14:26:02.114Z", mode: "incremental", appended: 2, stored: 240, incomplete: false }],
          };
        }
        case "recorder.sync":
          return { ok: true, result: { listed: 3, synced: 1, skipped: 2, partial: 0, failed: 0 }, status: STATUS };
        case "recorder.export":
          return {
            ok: true,
            files: {
              markdown: "…\\archive\\exports\\8f2c1d4e-2026-09-28.md",
              jsonl: "…\\archive\\exports\\8f2c1d4e-2026-09-28.jsonl",
            },
            status: STATUS,
          };
        case "recorder.delete":
          return { ok: true, deleted: true, status: STATUS };
        default:
          return { ok: false, error: `unknown channel: ${channel}` };
      }
    },
    on() {
      return () => {};
    },
  };
})();
