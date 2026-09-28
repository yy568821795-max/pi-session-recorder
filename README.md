# pi-session-recorder（开发仓库）

PI-Desktop 插件 **Session Recorder / 会话记录器** 的开发仓库。

**发布目录是 `plugin/`**：只有它的内容会被打包成 `.piplug`、也只有在应用里「加载开发插件」时选它才对。

```text
pi-session-recorder/                 ← 仓库根（从这里 git push / publish）
├─ plugin/                            ← 发布目录（= 官方 plugins/<id>/ 结构）
│  ├─ manifest.json                   id: com.github.yy568821795-max.session-recorder
│  ├─ main.js                         插件进程入口（CommonJS，宿主注入全局 pi）
│  ├─ lib/                            recorder-core / archive-store / sync-engine / host-adapter
│  ├─ renderer/                       index.html / panel.css / panel.js
│  ├─ README.md                       市场详情页展示的说明（命令/设置/工具/权限/数据）
│  └─ LICENSE
├─ dev/                               ← 只在本机跑，不进发布包
│  ├─ recorder-core.test.mjs          纯逻辑
│  ├─ sync-engine.test.mjs            同步引擎（模拟宿主）
│  ├─ plugin-load.test.mjs            用 stub pi 加载真 main.js
│  ├─ panel-render.test.mjs           DOM stub 里跑真 panel.js
│  ├─ dom-stub.mjs / panel-preview-fixture.js
│  ├─ panel-preview.html              生成产物（由 npm test 校验是否过期）
│  └─ build-preview.mjs
├─ package.json                       npm 脚本
├─ LICENSE
└─ .gitignore
```

> 为什么这样分：官方 devkit 只自动排除 `.git`、`node_modules`、`dist`，没有忽略文件机制；把测试放在插件根里会被**打进发布包**（夹具里还有测试用的假密钥串，安全审计会很不喜欢）。发布目录只留运行必需文件，是官方仓库里所有插件的实际做法。

## 日常开发

```bash
# 全部测试（含预览产物一致性检查）
npm test
# 只跑某一层
npm run test:core        # 纯逻辑 + 同步引擎
npm run test:plugin      # stub pi + 真 main.js
npm run test:panel       # DOM stub + 真 panel.js
# 改了 renderer/ 或夹具后重新生成预览
npm run preview
```

应用里验收：**插件 → 加载开发插件 → 选 `…\pi-session-recorder\plugin`**，然后
命令面板执行「会话记录器：打开」；改了代码后**要重新加载 dev 插件**才会生效。

> id 变更提示：`0.3.0` 把 id 从 `local.session-recorder` 改为
> `com.github.yy568821795-max.session-recorder`，数据目录随之变化。旧归档留在
> `plugins\data\local.session-recorder\archive`，需要的话整目录拷到新 id 的数据目录即可。

## 官方校验 / 打包 / 提交（方案 B）

```bash
# 1) 官方校验（在 PI-Desktop 仓库根执行；会打印阻塞错误与非阻塞警告）
pnpm pi-plugin check  D:\work_space\java_work_space\pi-session-recorder\plugin
# 2) 打包 + 记录 SHA-256
pnpm pi-plugin pack   D:\work_space\java_work_space\pi-session-recorder\plugin
# 3) 在插件页「安装插件包」里装一次 dist/<id>-<version>.piplug，确认权限审查与贡献项
# 4) 生成插件中心提交载荷（需要干净的 git 树 + origin 指向 GitHub + 打 tag）
pnpm pi-plugin publish D:\work_space\java_work_space\pi-session-recorder\plugin --channel stable
```

`.piplug` 必须由 devkit 产出（普通 zip 默认压缩会被安装器拒绝）；包里 19 个文件、最大 50 MB。

## 在线调试（真数据看渲染）

用 `agent/pi-plugins/tools/real-panel-server.mjs`（见
`agent/pi-plugins/live-debugging-playbook.md`）把真插件 + 真归档副本 + 宿主 tokens 挂在本地端口，
再用 chrome-devtools MCP 驱动浏览器做全量审计：

```powershell
node D:\work_space\java_work_space\public_utils\agent\pi-plugins\tools\real-panel-server.mjs `
  --plugin D:\work_space\java_work_space\pi-session-recorder\plugin `
  --data   "$env:USERPROFILE\.pi-desktop\plugins\data\com.github.yy568821795-max.session-recorder" `
  --tokens D:\work_space\java_work_space\PI-Desktop\apps\desktop\src\styles\tokens.css
```

## 目录约定（改这个仓库时请保持）

1. `plugin/` 里只放运行必需文件；任何测试、夹具、脚本一律放 `dev/`。
2. `dev/` 的路径引用统一走 `pluginRoot = <repo>/plugin`。
3. 改 `plugin/renderer/*` 或预览夹具后，必须重新生成 `dev/panel-preview.html`，否则 `npm test` 会报过期。
4. 版本号三处一致：`plugin/manifest.json`、`package.json`、manifest 的 `changelog` 首段。
