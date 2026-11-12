# RabbitBots Phase 1B-1 — Frontend Discovery

> 只读源码勘察报告。本阶段不修改业务代码、数据库、Prisma Schema 或依赖，不执行 commit / push。
> 报告中的每个结论都标注了仓库内真实文件与行号；`[建议]` 与 `[待验证]` 明确区别于 `[事实]`。

## 0. 元信息

| 项 | 值 |
| --- | --- |
| 仓库 | RabbitBots（Rakazo monorepo） |
| 分支 | `main` |
| HEAD | `6c7e1bcc6` |
| 工作区 | 38 个已修改路径：37 个仅文件模式变化（`100755 → 100644`），1 个内容变化：`scripts/dev.mjs` |
| 必须保留的本地修改 | `scripts/dev.mjs:48`：本地 PostgreSQL 映射端口 `54318 → 55450` |
| 本阶段产物 | 仅本报告文件；未改业务源码、数据库、依赖；未 commit / push |
| 勘察方式 | 源码静态阅读（未启动 dev server / 浏览器） |

### 0.1 基线核对（已验证）

```
$ git rev-parse --short HEAD
6c7e1bcc6
$ git diff -- scripts/dev.mjs
-  port: 54318,
+  port: 55450,
```

- 37 个 mode-only 路径（如 `infra/compose/backup-drill.sh`、`scripts/backup.sh`）只有 `old mode 100755 / new mode 100644`，无内容差异。这是当前 Windows/WSL 挂载环境造成的既有状态，本阶段未改动、未回滚。
- `scripts/dev.mjs` 的内容修改保持原样，未被本报告覆盖。
- 结论：**基线与用户描述一致，唯一的业务内容改动仍是 dev Postgres 端口**。

### 0.2 结论标记

| 标记 | 含义 |
| --- | --- |
| `[事实]` | 已在本仓库源码中逐行确认 |
| `[建议]` | 实施建议，本阶段未落地 |
| `[待验证]` | 依赖运行环境 / 浏览器 / 数据，需要实际打开页面确认 |

> 引用约定：首次出现的文件给仓库相对完整路径；同一节内后续引用可能只写唯一文件名（如 `Shell.tsx`），均指该节已给出的文件。所有行号以当前 HEAD `6c7e1bcc6` 为准。

---

## 1. 执行摘要

1. `[事实]` Web 端是 Vite + React 19 + `react-router-dom` 7 的单页应用；真正的产品外壳只有一个：`/app`、`/app/:botId`、`/app/g/:groupId` 都渲染同一个 `ShellPage`。入口见 `apps/web/src/main.tsx:59-83`，路由表见 `apps/web/src/App.tsx:181-300`，外壳见 `apps/web/src/pages/Shell.tsx:120-124`。
2. `[事实]` **左侧 Bot Roster 已经存在**（`ShellSidebar` + `SidebarRoster`），**中间独立 Chat 已经存在**（`<main>` 内的 `ChatHeader` + `Transcript` + `Composer`）；两者不是待新建模块，而是待裁剪/改造模块。
3. `[事实]` **右侧 Computer 栏不是常驻栏**：它是 `ShellSidePanel` 这个可开可关、可拖宽的单一右栏；初始 `panel = null`，首次点击聊天标题默认打开的是 **Routines**（`apps/web/src/pages/Shell.tsx:201`、`apps/web/src/pages/Shell.tsx:419-428`），Computer 只是 `BotSettings` 里的四个 Tab 之一（`apps/web/src/pages/shell/bot-panel.tsx:530-555`）。
4. `[事实]` 右栏同一时刻只能承载一种内容：`Panel` 是联合类型（`apps/web/src/lib/right-panel-state.ts:1-11`），Computer、Routines、Pages、Settings 互斥；并且每个 chat 各自记住自己的面板状态（`apps/web/src/pages/shell/use-right-panel.ts:124-158`），**切换 bot 会按该 bot 上次的状态关闭或切换右栏**——这是"常驻 Computer Workspace"最主要的架构阻碍。
5. `[事实]` Computer 的可见性被硬编码为 `panel === "computer" || computerOpen`（`apps/web/src/pages/shell/use-computer.tsx:379`），屏幕刷新受它 gate（`apps/web/src/pages/shell/use-computer.tsx:419-420`）；新增常驻栏必须同步改这里，否则新栏拿不到实时屏幕。
6. `[事实]` 打开 Computer Tab 会自动 `refreshThread` 并**自动开机**（`apps/web/src/pages/shell/use-computer.tsx:673-703`），Computer 面板或全屏打开、且电脑处于 running 时，每 60s 发 heartbeat 保持唤醒（`apps/web/src/pages/shell/use-computer.tsx:746-760`）。常驻栏若复用该逻辑，切换 bot 会触发反复开机；演示前必须先定策略。
7. `[事实]` 三个 bot 不是硬编码的：Roster 完全由 `rpc.spaces.list()` 返回的数据驱动（`apps/web/src/pages/shell/use-space-roster.ts:76-146`），排序为 `pinned desc, position asc, createdAt asc`（`packages/db/src/repos.ts:360-376`）。因此 CEO Assistant / Research Bot / Finance Bot 是**数据准备**问题，不是组件改造问题。
8. `[事实]` 新账号 onboarding 会自动创建一个名为 **"Chief"** 的 bot（`apps/web/src/pages/onboarding/first-bot.tsx:5,27-33`），默认 space 名为 **"Personal"**（`packages/db/src/bootstrap-user.ts:109-114`）；只有一个 space 且无 section 时，Roster 顶部会显示这个 space 名作为分组标题（`apps/web/src/pages/shell/space-sidebar.ts:49,96`）。演示前需要改名或隐藏。
9. `[事实]` **主应用 shell 内没有可见的 Rakazo Logo / wordmark**：侧栏头部只有窗口控制占位和图标按钮（`apps/web/src/pages/shell/sidebar-header.tsx:45-150`），品牌图形只出现在登录页（`apps/web/src/pages/Auth.tsx:568-571` 的两根竖条）、favicon/PWA 图标，以及公开分享页把 favicon 当小 logo 用的地方（`apps/web/src/components/pages/PublicPageShell.tsx:30`）；`Wordmark` 组件虽然存在（`packages/ui-web/src/bot-avatar.tsx:410-422`）但没有任何 app 引用。
10. `[事实]` 亮色主题已经非常接近"白色 macOS 企业 SaaS"：`--background #ffffff`、`--sidebar #f5f5f5`、`--card #f2f2f2`、`--radius 0.75rem`（`packages/ui-tokens/src/tokens.css:60-114`），字体是系统字体栈并对 macOS 用 420 字重（`packages/ui-web/src/styles.css:13,43-46`）。但默认外观跟随系统（`apps/web/public/theme.js:9-12`），**演示机若为深色模式会直接变黑**，需要强制 light。
11. `[事实]` 品牌名改造不是全局替换：`Rakazo` 出现在 15 个语言目录、每个约 44–46 处，且部分字符串被测试断言或与 `packages/core` 的运行时错误常量绑定（`apps/web/src/lib/i18n-catalog.test.ts:46,75`、`packages/core/src/run-error.ts:36-38`、`apps/web/src/lib/run-error.ts:39-44`）。
12. `[事实]` 当前布局在 1440px 宽、默认 316px 侧栏 + 384px 右栏下，中间 Chat 只有 740px；在 1280px 下只有 580px；低于约 956px 时右栏改为覆盖式浮层（`apps/web/src/pages/ResizableSidePanel.tsx:42`）。演示分辨率选择会直接影响三栏观感。

---

## 2. Web 应用入口与路由结构

### 2.1 启动链（已验证）

| 层 | 文件 | 作用 |
| --- | --- | --- |
| HTML 壳 | `apps/web/index.html:1-23` | 静态 `<title>Rakazo</title>`、favicon/manifest 链接、`theme.js`（首屏前定主题） |
| 主题预处理 | `apps/web/public/theme.js:1-21` | 读 `localStorage["rakazo.uiAppearance"]`，写 `data-theme`；macOS 写 `data-os="mac"` |
| JS 入口 | `apps/web/src/main.tsx:1-84` | 安装 PWA/监控/字体方向，`createRoot` 挂载 |
| 全局 Provider | `apps/web/src/main.tsx:59-83` | `I18nBootstrap` → `BrowserRouter` → React Query → `DesktopUpdatesProvider` → `TooltipProvider` → `BotAvatarActivityProvider` |
| 应用根 | `apps/web/src/App.tsx:94-111` | 三个特殊路径（SSO / integrations callback）外都进 `SessionApp` |
| 会话门 | `apps/web/src/App.tsx:113-175` | `authClient.useSession()` + session gate；未登录重定向在更外层路由（`apps/web/src/App.tsx:277-286`） |

关键点：

- `[事实]` `BrowserRouter` 显式使用 `useTransitions={false}`，注释说明在流式消息场景下 transition 会让 deep link / 线程切换拿不到新 URL（`apps/web/src/main.tsx:64-69`）。改造布局时不要把路由包进 `startTransition`。
- `[事实]` 全局 Provider 不包含任何布局/Workspace Provider；三栏布局完全由 `ShellPage` 自己组合。
- `[事实]` 监测、Service Worker、缩放锁定在模块求值阶段执行（`apps/web/src/main.tsx:25-32`），与 UI 无关，但会污染性能时间线。

### 2.2 路由表（已验证）

`apps/web/src/App.tsx:181-300` 是完整路由定义。与本次改造相关的只有：

| 路径 | 元素 | 证据 |
| --- | --- | --- |
| `/` | 重定向：已登录 → `/app`，否则 `/sign-in` 或 `/sign-up` | `apps/web/src/App.tsx:182-190` |
| `/app` | `ShellPage`（无选中 bot，由 Shell 内部补第一个） | `apps/web/src/App.tsx:288` |
| `/app/:botId` | `ShellPage`（选中该 bot） | `apps/web/src/App.tsx:290` |
| `/app/g/:groupId` | `ShellPage`（选中该群聊） | `apps/web/src/App.tsx:289` |
| `/app/artifacts`、`/app/artifacts/:artifactId`、`/app/board`、`/app/x/:linkId`、`/onboarding/:step?` | `CallLayout` 下的独立页面，**不是**三栏外壳 | `apps/web/src/App.tsx:291-297` |
| `/p/:slugToken` | 公开分享页（无登录） | `apps/web/src/App.tsx:214` |
| 其余 | `NotFoundPage` | `apps/web/src/App.tsx:299` |

- `[事实]` `/app` 与 `/app/:botId` 共用同一个 `ShellPage` 实例类型，切换 bot 不卸载外壳，只换 URL 参数（`apps/web/src/App.tsx:288-290`）。
- `[事实]` 所有应用内路由被 `SubscriptionGate` 包裹；计费部署下没有 access 会进 Paywall（`apps/web/src/App.tsx:277-286`）。
- `[事实]` 设置、集成、技能、模板等"浮层"不是独立路由，而是 URL query：`?settings=general`、`?integrations`、`?skills`、`?templates`、`?mcp=`、`?messaging`（`apps/web/src/pages/shell-overlay.ts:1-91`）。布局改造若引入"右栏 = 设置"的 URL 状态，需要与这套契约共存。

### 2.3 Shell 的实例化与重挂载（已验证）

```
ShellPage                         apps/web/src/pages/Shell.tsx:120-124
└── key={spaceEpoch}              ← 切换 space 时整壳重挂载，旧状态不跨 space
    └── SpaceShell                apps/web/src/pages/Shell.tsx:126
```

- `[事实]` `useSpaceEpoch()` 改变时 `<SpaceShell key={...}>` 会整体重建（`apps/web/src/pages/Shell.tsx:120-124`，`apps/web/src/lib/space-switch.ts` 提供 epoch）。
- `[事实]` 同一 space 内切换 bot 只改路由参数，`active` 由 `bots.find(...)` 重新计算（`apps/web/src/pages/Shell.tsx:282-288`），不会重建 Shell。
- `[事实]` 首次进入无 bot 的 space 且全账号无内容时，`refreshBots` 会重定向 `/onboarding`（`apps/web/src/pages/shell/use-space-roster.ts:117-129`）。演示账号必须已有内容，否则会落到 onboarding。
- `[事实]` 首次 bot 列表未回来前，Shell 返回 `PageLoading`，避免闪一下 "Select a bot"（`apps/web/src/pages/Shell.tsx:1414-1419`）。

### 2.4 对改造的约束（事实 + 建议）

- `[事实]` bot 选择状态只存在于 URL（`/app/:botId`），没有全局 store；任何"三栏"实现都应继续以 URL 为准，否则刷新/深链会丢选中项。
- `[建议]` 不要把三栏布局做成新的顶层路由（例如 `/app/:botId/workspace`）。现有 deep link、e2e、SSE 订阅、草稿 key 全部以 `botId` 为锚（`apps/web/src/pages/Shell.tsx:1144-1146`、`apps/web/src/pages/shell/use-thread-sync.ts:329-332`），新增层级会牵连过多。
- `[建议]` 右栏的"是否展开"属于 UI 偏好，不应进 URL；但"当前打开的是设置还是 Computer"如果要做成可分享状态，应复用 `shell-overlay.ts` 的 query 约定，而不是另起一套。

---

## 3. 主布局与左侧导航

### 3.1 现有三栏骨架（已验证）

根节点是 `BotsSidebarLayout`，渲染在 `apps/web/src/pages/Shell.tsx:919-930`，其 `className` 含 `relative flex h-full ... overflow-hidden`：

```
BotsSidebarLayout  (SidebarProvider, --sidebar-width = 316px 默认)
├── Sidebar（aside）           ← Bot Roster / 搜索 / Activity / 账号页脚
├── main（flex-1, min-w-0）    ← ChatHeader + Transcript + Composer
├── PageViewHost               ← ?page=<id> 的全屏页面，可盖住 chat
├── ShellSidePanel（aside）    ← 右栏：BotSettings / 群设置 / Routine / 导入
├── ShellDialogs / AppOverlays / SettingsOverlays
└── ComputerOverlay（fixed）   ← 全屏 Computer
```

证据：

- 根节点与 class：`apps/web/src/pages/Shell.tsx:920-929`（含 `relative`，是右栏绝对定位的定位父级）。
- `Sidebar`：`apps/web/src/pages/Shell.tsx:939-1026`。
- `main`：`apps/web/src/pages/Shell.tsx:1029-1207`，`className="isolate flex min-w-0 flex-1 flex-col bg-background"`。
- `ShellSidePanel`：`apps/web/src/pages/Shell.tsx:1217-1306`。
- `ComputerOverlay`：`apps/web/src/pages/Shell.tsx:1380-1410`。

`[事实]` 这不是"左栏 + 中间"的两栏：右栏存在时它在 `md+` 是 `relative` 的 flex 子项，会真实挤占中间宽度；在窄屏是 `absolute` 覆盖（`apps/web/src/pages/ResizableSidePanel.tsx:76-82`）。也就是说**三栏的 DOM/CSS 骨架已经具备**，缺的是"右栏默认常开且内容为 Computer"。

### 3.2 左栏内部结构（已验证）

`ShellSidebar`（`apps/web/src/pages/shell/shell-sidebar.tsx:56-320`）自上而下：

| 区域 | 内容 | 证据 |
| --- | --- | --- |
| 顶部工具行 | `WindowChrome` 占位（浏览器下是 72px 空白）+ 搜索 / Activity / 折叠 / 新建 | `apps/web/src/pages/shell/sidebar-header.tsx:45-150` |
| 搜索框 | 只在搜索或 Activity 模式下出现 | `apps/web/src/pages/shell/shell-sidebar.tsx:193-250` |
| 列表滚动区 | `SidebarRoster`，或搜索结果 / Activity 列表 | `apps/web/src/pages/shell/shell-sidebar.tsx:251-290` |
| 折叠货架 | Snoozed / Archived；为空时各自返回 `null` | `apps/web/src/pages/shell/shell-sidebar.tsx:291-300`、`apps/web/src/pages/shell/snoozed-chats.tsx:27`、`apps/web/src/pages/shell/archived-chats.tsx:36` |
| Passkey 提示 | 新账号首次会话可能出现的侧栏提示 | `apps/web/src/pages/shell/shell-sidebar.tsx:301-303`、`apps/web/src/components/PasskeyOffer.tsx:46-68` |
| 页脚 | 免费试用倒计时、账号菜单、集成/技能/设置/登出 | `apps/web/src/pages/shell/shell-sidebar.tsx:304-453`、`apps/web/src/components/SidebarFooter.tsx` |

`[事实]` 桌面端 `Sidebar` 由 shadcn 的 `Sidebar` 实现：先渲染一个 `--sidebar-width` 的 gap，再渲染 `fixed` 的 aside（`packages/ui-web/src/components/ui/sidebar.tsx:182-224`）。所以根 flex 布局里真正占位的是 gap，右栏与 `main` 都在 aside 之后。
`[事实]` 左栏宽度由 `SidebarProvider` 的 CSS 变量驱动（`apps/web/src/pages/shell/sidebar-layout.tsx:42-44`），不写死 Tailwind 宽度。
`[事实]` 窗口拖拽区（`app-drag`）在侧栏顶部和聊天顶部都有；浏览器里无效果，Electron 里用于拖动窗口（`apps/web/src/styles.css:82-89`）。

### 3.3 Roster 的数据与分组（已验证）

数据流：

```
useSpaceRoster (apps/web/src/pages/Shell.tsx:157)
  ├─ 初始 seed: bootstrap / React Query 缓存 (apps/web/src/pages/Shell.tsx:137-143)
  └─ refreshBots(): rpc.spaces.list() → { bots, botSections, groups, spaces }
                      (apps/web/src/pages/shell/use-space-roster.ts:76-146)
       ↓
sidebarSpaces (apps/web/src/pages/Shell.tsx:549-571)
       ↓
sidebarGroupsForSpaces(spaces, query, labels, now)   (apps/web/src/pages/shell/space-sidebar.ts:42-147)
       ↓
groupBotsForSidebar(items, botSections, { labels })  (packages/core/src/bot-sections.ts:10-54)
       ↓
<SidebarRoster sidebarGroups={...}>                  (apps/web/src/pages/Shell.tsx:958-989)
```

关键事实：

- `[事实]` 排序：后端 `listBots` 按 `pinned desc, position asc, createdAt asc`（`packages/db/src/repos.ts:360-376`）；`position` 由拖拽 reorder 写入（`apps/web/src/pages/shell/use-space-roster.ts:148-172`、`apps/web/src/pages/Shell.tsx:767-775`）。
- `[事实]` 分组：先 Pinned，再各 section，最后 Unassigned；没有 section 时全部归入 Unassigned（`packages/core/src/bot-sections.ts:21-51`）。
- `[事实]` 只有一个 space 且没有 section 时，`sidebarGroupsForSpaces` 会把该 group 的 `title` 设成 **space 名**（`apps/web/src/pages/shell/space-sidebar.ts:96`），而不是 "Unassigned"。默认 space 名是 **"Personal"**（`packages/db/src/bootstrap-user.ts:109-114`）。
- `[事实]` `apps/web/src/pages/Shell.tsx:559` 还有一个硬编码的 `name: "Personal"` 兜底（当 `spaces.length === 0` 时构造伪 space）。演示中若 API 还没返回 spaces，也会看到 "Personal"。
- `[事实]` 搜索会同时匹配 `name + preview`，并临时忽略 snooze（`apps/web/src/pages/shell/space-sidebar.ts:48-54`）。
- `[事实]` 统计未读数时特意忽略搜索过滤（`apps/web/src/pages/Shell.tsx:582-586`），用于 Dock badge。

`[建议]` RabbitBots 的三固定 bot 场景下，这个 "Personal" 分组头是噪音。最小改法不是改数据逻辑，而是：

- 数据侧：把 space 改名为 `RabbitBots`（侧栏 Space 菜单或设置 → Space，`apps/web/src/pages/shell/use-space-actions.ts:25-37`），分组头立刻变成品牌名；
- 或者 UI 侧：当 `spaces.length === 1` 且 `botSections.length === 0` 时不渲染分组头（只改 `SidebarRoster` 的 header 条件，不动分组算法）。

### 3.4 Roster 行解剖（已验证）

单行由 `SidebarRoster` 渲染（`apps/web/src/pages/shell/sidebar-roster.tsx:275-581`）：

| 元素 | 说明 | 证据 |
| --- | --- | --- |
| 头像 | `BotAvatar`，尺寸随密度：mini 40 / compact 28 / comfortable 38 | `apps/web/src/pages/shell/sidebar-roster.tsx:314-331` |
| 名称 | `item.chat.name`，未读时 `font-semibold` | `apps/web/src/pages/shell/sidebar-roster.tsx:458-466` |
| 右侧 | "Woke" 或相对时间；未读圆点 | `apps/web/src/pages/shell/sidebar-roster.tsx:473-497` |
| 第二行 | 运行状态（Waiting/Starting/Working）或消息 preview；compact 模式显示短状态 | `apps/web/src/pages/shell/sidebar-roster.tsx:292-298,498-535`、`apps/web/src/lib/roster-status.ts:10-37` |
| 选中态 | `bg-sidebar-accent` | `apps/web/src/pages/shell/sidebar-roster.tsx:413-416` |
| 拖拽 | 仅 bot 可拖；`data-roster-bot-id`；Alt+↑/↓ 键盘换序 | `apps/web/src/pages/shell/sidebar-roster.tsx:336-395` |
| 右键菜单 | Pin / 未读 / Snooze / Move to section / Edit / Duplicate / Clear / Archive / Delete | `apps/web/src/pages/shell/sidebar-roster.tsx:548-579`、`apps/web/src/pages/shell/chat-context-menu.tsx:49-125` |

`[事实]` `BotSchema` 有 `description` 字段（`packages/contracts/src/domain.ts:83-136`），但 Roster 行**不显示** description；行内第二行固定是 preview/status。`title` 字段标注为 "Always empty; installed mobile apps still read it"（`packages/contracts/src/domain.ts:87-88`）。
`[建议]` 若 RabbitBots 想显示 "CEO Assistant / 研究 / 财务" 的角色副标题，最小做法是复用 `description`（数据已有、设置里可编辑），在 Roster 行加一个第二行优先级分支；不要新增数据库字段。

### 3.5 折叠、拖宽与断点（已验证）

| 行为 | 值 | 证据 |
| --- | --- | --- |
| 默认宽度 | 316px | `apps/web/src/lib/bots-sidebar-pref.ts:24` |
| 最小 / 最大 | 240 / 480px | `apps/web/src/lib/bots-sidebar-pref.ts:25-26` |
| 折叠为图标 | 72px | `apps/web/src/lib/bots-sidebar-pref.ts:23`；`apps/web/src/pages/shell/sidebar-layout.tsx:43` |
| 拖到 160px 以下自动折叠 | `BOTS_SIDEBAR_SNAP_WIDTH` | `apps/web/src/lib/bots-sidebar-pref.ts:27`、`apps/web/src/pages/shell/use-sidebar-resize.ts:63-72,82-94` |
| 移动端断点 | 768px；<768 用抽屉 | `packages/ui-web/src/hooks/use-mobile.ts:3-5`、`apps/web/src/pages/shell/shell-sidebar.tsx:149-163` |
| 宽度持久化 | `rakazo:bots-sidebar-width:<userId>` | `apps/web/src/lib/bots-sidebar-pref.ts:30-32` |
| 折叠持久化 | `rakazo:bots-sidebar-collapsed:<userId>` | `apps/web/src/lib/bots-sidebar-pref.ts:5-21` |

`[事实]` 在浏览器（非 Electron）里，`WindowChrome` 只渲染 72px 的透明 spacer（`apps/web/src/lib/desktop.ts:51-56`、`apps/web/src/pages/WindowChrome.tsx:12-23`），所以侧栏顶部左侧有 72px 的空白留给 macOS 红绿灯。这块空白正好是放 RabbitBots wordmark 的天然位置。

### 3.6 对 RabbitBots 的直接影响（事实 + 建议）

- `[事实]` 三个 bot 会显示为三行，头像 + 名称 + 最后一条消息 preview + 时间；没有任何"角色"信息。
- `[事实]` 顶部工具行的搜索 / Activity / 新建 / 折叠四个按钮是为"多 bot + 多 section + 活动流"设计的；对三 bot 演示而言密度偏高（`apps/web/src/pages/shell/sidebar-header.tsx:51-148`）。
- `[建议]` 演示前把侧栏密度设为 `compact`（`apps/web/src/lib/bots-sidebar-density-pref.ts:3-15`，设置里有 Sidebar density 开关，`apps/web/src/pages/AccountSettingsOverlay.tsx:318-327`），三行会更紧凑；但这会让每行只显示状态/预览，不会增加信息量。
- `[建议]` 不要为了"好看"直接删掉搜索/Activity/新建入口——它们连接着命令面板、搜索、Activity 和创建流程；如要隐藏，应作为 RabbitBots 的 feature flag/布局分支统一处理。

---

## 4. Bot 列表、Bot 选择与聊天组件

### 4.1 Bot 数据模型（已验证）

`BotSchema`（`packages/contracts/src/domain.ts:83-137`）的关键字段：

| 字段 | 用途 | 证据 |
| --- | --- | --- |
| `id`, `spaceId`, `name` | 身份与归属 | `packages/contracts/src/domain.ts:84-86` |
| `description`, `instructions` | 描述与系统指令（设置 Advanced 里编辑） | `packages/contracts/src/domain.ts:89-90` |
| `color`, `avatarSet` | 唯一身份色 + 头像风格（`organic` / `rakazo`） | `packages/contracts/src/domain.ts:92-93`、`packages/contracts/src/bot-avatar.ts:4-9` |
| `pinned`, `sectionId` | Roster 分组 | `packages/contracts/src/domain.ts:95-96` |
| `unread`, `snoozedUntil` | 未读 / 打盹 | `packages/contracts/src/domain.ts:98-100` |
| `preview`, `status` | Roster 第二行 | `packages/contracts/src/domain.ts:104-105` |
| `computerMode` | `team` / `private` | `packages/contracts/src/domain.ts:108` |
| `threadId` | 每个 bot 一条独立线程 | `packages/contracts/src/domain.ts:103` |
| `updatedAt` | Roster 时间 | `packages/contracts/src/domain.ts:109` |

`[事实]` 创建接口 `CreateBotInput` 接受 `name`、`description`、`instructions`、`notifyOnFinish`、`color`、`avatarFamily`、`computerMode`、`spawnKey`（`packages/contracts/src/domain.ts:445-465`）。**UI 的新建 Bot 弹窗只收集 name + 外观**（`apps/web/src/pages/shell/create-bot-dialog.tsx:24-31,94-120`），description/instructions/computerMode 需要后续在设置里补，或直接走 RPC。
`[事实]` `computerMode` 默认 `"team"`（`packages/contracts/src/domain.ts:462`）；team 模式下同 space 的 bot 共享一台 Team Computer（`docs/computer.md:27-35`）。三个演示 bot 若各自要有独立电脑，创建时必须传 `computerMode: "private"`。

### 4.2 选中逻辑（已验证）

```
URL /app/:botId
  → useParams().botId                        (apps/web/src/pages/Shell.tsx:128)
  → active = bots.find(b => b.id === (botId ?? routeChat?.botId))
             ?? bots.find(b => !snoozed)
             ?? bots[0]                       (apps/web/src/pages/Shell.tsx:282-288)
  → selectBot(id) { navigate(`/app/${id}`) } (apps/web/src/pages/Shell.tsx:289-295)
```

- `[事实]` Roster 点击走 `openSpaceChat(spaceId, path)`，同 space 内是 `navigate`，跨 space 会先切 space 再导航甚至整页 reload（`apps/web/src/pages/shell/sidebar-roster.tsx:396-401`、`apps/web/src/pages/shell/use-space-switch.ts:45-136`）。
- `[事实]` 键盘切换：Ctrl+Tab / Cmd+Shift+↑↓ 在 roster 顺序里循环（`apps/web/src/pages/Shell.tsx:319-326,399-405`、`apps/web/src/pages/shell/shell-shortcuts.ts:70-81,109-120`）。
- `[事实]` `/app` 且无 botId 时会用 `lastChat` 缓存或第一个 bot 兜底（`apps/web/src/pages/Shell.tsx:137-143,280-288`）。
- `[事实]` 群聊走 `/app/g/:groupId`，此时 `inGroup = true`，Computer 面板不可用（见 5.6）。

### 4.3 Chat 工作区组件树（已验证）

`main`（`apps/web/src/pages/Shell.tsx:1029-1207`）内：

```
main
├── mobile sidebar 滑动边缘 (apps/web/src/pages/Shell.tsx:1036-1042)
├── CallReturnBar                                  (apps/web/src/pages/Shell.tsx:1043)
├── div.chatColumn (relative, flex-1)
│   ├── 顶部 app-drag 3px 拖拽条                    (apps/web/src/pages/Shell.tsx:1047)
│   ├── ChatFindBar（按需）                         (apps/web/src/pages/Shell.tsx:1048-1059)
│   ├── ChatHeader（absolute 浮在 transcript 上）   (apps/web/src/pages/Shell.tsx:1060-1078)
│   ├── 空态 "New bot"（无 bot 时）                  (apps/web/src/pages/Shell.tsx:1079-1086)
│   └── Transcript                                  (apps/web/src/pages/Shell.tsx:1087-1134)
└── 底部 Composer 区（-mt-7 与 transcript 圆角衔接）  (apps/web/src/pages/Shell.tsx:1136-1206)
```

关键点：

- `[事实]` `ChatHeader` 是 `absolute inset-x-0 top-0 z-10` 的浮层，transcript 从它下面滚过（`apps/web/src/pages/shell/chat-header.tsx:44`、`apps/web/src/pages/shell/transcript.tsx:516` 的 `pt-20 md:pt-[84px]`）。这是"macOS 浮动工具栏"观感的核心。
- `[事实]` 标题胶囊显示头像 + bot 名，点击打开/关闭右栏（`apps/web/src/pages/shell/chat-header.tsx:57-82`、`apps/web/src/pages/Shell.tsx:1068-1070`、`toggleChatPanel` `apps/web/src/pages/Shell.tsx:419-428`）。
- `[事实]` 右侧有 Call / Invite 按钮，取决于 `phoneCallsEnabled` 和 billing referral（`apps/web/src/pages/shell/chat-header.tsx:83-113`）。
- `[事实]` Composer 在桌面端是底部居中、最大 60rem 内容宽，圆角 26px 的容器（`apps/web/src/pages/shell/composer.tsx:597,666-667`）；移动端通过 portal 停靠，`docked` 样式不同（`apps/web/src/pages/shell/composer.tsx:869-890`）。
- `[事实]` 消息内容不会超过约 39rem（`apps/web/src/pages/shell/transcript.tsx:56-60`），长文可读性优先于填满宽屏。中间栏变窄时优先压缩留白，而不是压缩气泡。

### 4.4 消息渲染（已验证）

- `Transcript` 是 `memo` 组件，负责滚动跟随、未读分隔、时间分隔、引用、跳转、加载更早消息（`apps/web/src/pages/shell/transcript.tsx:62-103,472-701`）。
- `MessageView` 负责单条消息的 block 渲染（`message-view.tsx`），包括 computer card（`apps/web/src/pages/shell/message-view.tsx:695` 的 `onOpenComputer`）。
- 运行中状态由 `ActiveBotGlyph` 渲染（`apps/web/src/pages/shell/transcript.tsx:668-673`、`apps/web/src/components/ai/CollaborationMarker.tsx:45`）。
- `[事实]` Transcript 的滚动 key 是 `activeSnapshot?.threadId`（`apps/web/src/pages/Shell.tsx:1088`），即切换 bot 会重挂 transcript，滚动位置不跨 bot 保留（是否回到顶部由组件内部逻辑决定；`[待验证]` 见 §9）。
- `[事实]` Composer 的 key/draftKey 是 `bot:<id>` 或 `group:<id>`（`apps/web/src/pages/Shell.tsx:1144-1146`），草稿按 chat 隔离并持久化（`apps/web/src/lib/composer-draft.ts`）。

### 4.5 "独立 Chat Workspace" 的判断

`[事实]` 数据层已经是独立的：每个 bot 有独立 `threadId`、独立 draft、独立未读/已读边界、独立右栏记忆；SSE 订阅只针对当前 active 线程（`apps/web/src/pages/shell/use-thread-sync.ts:430`），切走时缓存快照（`apps/web/src/pages/shell/use-thread-sync.ts:427-429`）。
`[建议]` "独立 Chat Workspace" 在 1B 里不需要新造"workspace"实体；需要做的是**视觉/布局上的独立性**：让中间列看起来是一块独立画布（边界、留白、标题），而不是现有 shell 的剩余空间。技术上推荐只动 `main` 的容器 class 和 `ChatHeader` 的层级，不动线程/草稿模型。

---

## 5. Computer Overlay / Computer Panel / 状态管理

### 5.1 三个渲染面（已验证）

| 面 | 组件 | 出现位置 | 证据 |
| --- | --- | --- | --- |
| 右栏预览 | `ComputerPanel` | `BotSettings` 的 Computer Tab | `apps/web/src/pages/Shell.tsx:1235-1282` → `apps/web/src/pages/shell/side-panel.tsx:198` → `apps/web/src/pages/shell/bot-panel.tsx:545-547` |
| 全屏 | `ComputerOverlay` | `computerOpen === true` 时 fixed 覆盖整页 | `apps/web/src/pages/Shell.tsx:1380-1410`、`apps/web/src/pages/shell/computer-overlay.tsx:78-87` |
| 群聊内卡片入口 | `MessageView` 的 computer card → `onOpenComputer` | 消息流中 | `apps/web/src/pages/shell/message-view.tsx:695`、`apps/web/src/pages/Shell.tsx:1130` |

`[事实]` 右栏预览本身是只读的：iframe `pointerEvents: "none"`（`apps/web/src/pages/shell/computer-panel.tsx:167`）；全屏也只有 `hasControl` 时才允许交互（`apps/web/src/pages/shell/computer-overlay.tsx:217-220`）。所以"右侧常驻 Workspace"天然是**观看态**，交互仍需 `Take control` 进全屏。

### 5.2 状态与 RPC（已验证）

`useComputerState`（`apps/web/src/pages/shell/use-computer.tsx:57-515`）持有：

- `computer: ComputerStatus | null`、`computerOpen`、`computerBotId`、`screenUrl`、`booting`、`screenFrameKey`、`heldScreen`、`computerViewport`、错误状态（`apps/web/src/pages/shell/use-computer.tsx:69-124`）。
- 每个 bot 的 computer/screen 缓存 `computerCacheRef`，上限 20（`apps/web/src/pages/shell/use-computer.tsx:48-54,383-394`）。
- 屏幕 URL 的读取、重连、held frame、iframe 消息协议（`apps/web/src/pages/shell/use-computer.tsx:165-358`）。

`useComputerControls`（`apps/web/src/pages/shell/use-computer.tsx:519-949`）暴露：

- `openComputer(botId, takeControl?)`：打开全屏并（可选）boot / takeover（`apps/web/src/pages/shell/use-computer.tsx:763-801`）。
- `releaseComputer(reason?)`：释放控制（`apps/web/src/pages/shell/use-computer.tsx:808-835`）。
- `computerScreenError` / `computerBooting` / `hasControl` / `embeddedScreenUrl`（`apps/web/src/pages/shell/use-computer.tsx:837-948`）。

RPC 面（已与 `packages/contracts/src/rpc.ts:810-866` 的定义对照；下表行号是调用点）：

| RPC | 时机 | 证据 |
| --- | --- | --- |
| `computer.boot` | 打开/唤醒 | `apps/web/src/pages/shell/use-computer.tsx:634-636` |
| `computer.status` | 非 active bot 刷新 | `apps/web/src/pages/shell/use-computer.tsx:666-669` |
| `computer.screenUrl` | 读取屏幕 URL | `apps/web/src/pages/shell/use-computer.tsx:424` |
| `computer.takeover` | Take control | `apps/web/src/pages/shell/use-computer.tsx:644` |
| `computer.release` | 释放 | `apps/web/src/pages/shell/use-computer.tsx:821` |
| `computer.heartbeat` | 面板/全屏打开且 running，每 60s | `apps/web/src/pages/shell/use-computer.tsx:746-760` |
| `computer.dismissDiskWarning` | 磁盘告警 | `apps/web/src/pages/Shell.tsx:316` |

### 5.3 打开路径与自动行为（已验证）

- `[事实]` **点标题 → 默认 Routines**：`lastBotTab` 初值是 `"routines"`（`apps/web/src/pages/Shell.tsx:201`）；`toggleChatPanel` 打开 `lastBotTab.current`（`apps/web/src/pages/Shell.tsx:419-428`）。Computer 需要用户在 BotSettings 里点 Tab（`apps/web/src/pages/shell/bot-panel.tsx:532-534`）。
- `[事实]` **打开 Computer Tab 会自动开机**：`useEffect([panel, active?.id])` 在 `panel === "computer"` 时先 `refreshThread`，若没有可用屏幕则 `bootComputer(..., force: true)`（`apps/web/src/pages/shell/use-computer.tsx:673-703`）。
- `[事实]` **切换 bot 会关掉全屏 Computer**：`useEffect([active?.id])` 调 `setComputerOpen(false)` 并重置错误/当前 bot（`apps/web/src/pages/shell/use-computer.tsx:705-710`）。
- `[事实]` **全屏覆盖一切**：`fixed inset-0 z-30`（`apps/web/src/pages/shell/computer-overlay.tsx:79`），Esc 关闭（`apps/web/src/pages/shell/use-computer.tsx:736-744`）。
- `[事实]` 全屏打开时 `computerViewport` 跟随 `visualViewport`（`apps/web/src/pages/shell/use-computer.tsx:359-376`），移动端地址栏变化不会切掉屏幕。

### 5.4 屏幕获取的 gate（已验证）

- `computerVisible.current = panel === "computer" || computerOpen`（`apps/web/src/pages/shell/use-computer.tsx:379`）。
- `refreshComputerScreen` 开头 `if (!computerVisible.current) return null`（`apps/web/src/pages/shell/use-computer.tsx:419-420`）。
- thread 刷新与 computer 事件都会调用 `refreshComputerScreen`（`apps/web/src/pages/shell/use-thread-sync.ts:230-238,412-417`），但被上面的 gate 挡住。

`[事实]` 因此 **新增一个不是 `panel`、也不是 `computerOpen` 的常驻 Computer 栏时，不同步改 `computerVisible`，栏里永远不会有实时屏幕**。这是 1B-2 的第一个必改点（见 §8.4）。

### 5.5 空闲 / 错误 / 开机中的视觉（已验证）

`ComputerPanel` 的空闲态：灰底卡片、去色头像、"Asleep"、Wake 按钮（`apps/web/src/pages/shell/computer-panel.tsx:93-131`）。
运行态：`aspect-[16/10]` 容器内嵌只读 iframe（`apps/web/src/pages/shell/computer-panel.tsx:141-169`）。
打开态：hover 出现 "Open" 胶囊（`apps/web/src/pages/shell/computer-panel.tsx:192-205`）。
占位文案：`computerPlaceholder()` 返回 "Booting live desktop…" / "Computer is asleep. Open it to wake." / "Computer failed to boot" / "Computer is stopped"（`apps/web/src/pages/shell/computer-view.tsx:15-25`）。
标题：`computerLabel()` 返回 `<bot>’s computer` 或 `Team Computer`（`apps/web/src/pages/shell/computer-view.tsx:27-29`）。

`[建议]` 常驻 Workspace 若直接复用 `ComputerPanel`，会得到一个 16:10 的卡片而不是填满整列的屏幕；要么给 `ComputerPanel` 加 `fill` 变体，要么新写一个薄壳复用 `screenFrames` + 同样的空/错/开机态节点。两者都比复制 iframe 逻辑安全。

### 5.6 对"常驻 Computer Workspace"的耦合点（重点）

| # | 耦合点 | 现状 | 证据 | 影响 |
| --- | --- | --- | --- | --- |
| 1 | 可见性 gate | `panel === "computer" \|\| computerOpen` | `apps/web/src/pages/shell/use-computer.tsx:379,419-420` | 新栏不刷屏幕 |
| 2 | 自动开机 | `panel === "computer"` 时 boot | `apps/web/src/pages/shell/use-computer.tsx:673-703` | 新栏若照搬会切 bot 即开机 |
| 3 | 单槽联合类型 | Computer 与 Settings 互斥 | `apps/web/src/lib/right-panel-state.ts:1-11` | 无法同时显示 |
| 4 | 每个 chat 记忆面板 | 切 bot 会 restore 关闭/切换 | `apps/web/src/pages/shell/use-right-panel.ts:124-158` | "常驻"被切走 |
| 5 | 关闭按钮 | `setPanel(null)` | `apps/web/src/pages/shell/side-panel.tsx:129-136` | 用户可关掉右栏 |
| 6 | 窄屏覆盖 | <~956px 时 absolute | `apps/web/src/pages/ResizableSidePanel.tsx:42,76-82` | 三栏只在宽屏成立 |
| 7 | 宽高比 | 预览固定 16:10 | `apps/web/src/pages/shell/computer-panel.tsx:141-143` | 高栏留白 |
| 8 | 群聊 | `botTab && active` 才渲染 | `apps/web/src/pages/shell/side-panel.tsx:87-90,189` | 群聊没有 Computer |
| 9 | 心跳 | 面板/全屏打开且 running 时 60s 一次 | `apps/web/src/pages/shell/use-computer.tsx:746-760` | 常驻会长期保持唤醒 |
| 10 | 屏幕可用性 | 依赖 `me.sandboxProvider` | `apps/web/src/lib/computer-sandbox.ts:6-8`、`apps/web/src/pages/Shell.tsx:1250` | 无 sandbox 时只有提示 |
| 11 | 团队电脑 | 默认 `team`，多 bot 共享 | `packages/contracts/src/domain.ts:462`、`docs/computer.md:27-35` | 三个 bot 显示同一台 |

`[待验证]` 演示环境的 `SANDBOX_PROVIDER` 无法从源码确定（`.env.example:112` 默认 `docker`，真实值在未读取的 `.env` 里）。若为 `none` 或空字符串，`computersAreUnavailable()` 为真（`apps/web/src/lib/computer-sandbox.ts:6-8`），右栏只会显示 "Computers are unavailable" 类提示，而非桌面。

---

## 6. Rakazo 品牌资产盘点

### 6.1 运行时 Web 品牌面（已验证）

| 位置 | 当前值 | 证据 | 影响面 |
| --- | --- | --- | --- |
| 浏览器标题 | `Rakazo` | `apps/web/index.html:16` | 演示时最显眼的品牌 |
| iOS 添加到主屏名 | `Rakazo` | `apps/web/index.html:11` | 安装场景 |
| meta description | `Your team of always-on agents.` | `apps/web/index.html:6` | SEO/分享 |
| theme-color | `#0a0a0a`（随后由 `theme.js` 改写） | `apps/web/index.html:7`、`apps/web/public/theme.js:14-15` | 浏览器 UI 颜色 |
| favicon | `/favicon.ico`、`/favicon.png` 128×128 | `apps/web/index.html:12-13`、`apps/web/public/favicon.*` | 标签页 |
| apple-touch-icon | `/apple-touch-icon.png` | `apps/web/index.html:14`、`apps/web/public/apple-touch-icon.png` | iOS |
| PWA manifest | 运行时生成 `/site.webmanifest` | `apps/web/index.html:15`、`apps/web/src/pwa/plugin.ts:81-91`（dev）、`:104-105`（build） | 安装 |
| manifest name/short_name | 都是 `Rakazo` | `apps/web/src/pwa/plugin.ts:20-21` | Add to Dock / 安装名 |
| manifest description | `Your team of always-on agents.` | `apps/web/src/pwa/plugin.ts:22` | 安装描述 |
| manifest 配色 | 取 `webDarkTokens.background` | `apps/web/src/pwa/plugin.ts:26-27` | 安装窗口底色 |
| 图标文件 | `favicon-16/32.png`、`favicon.png`、`favicon.ico`、`apple-touch-icon.png`、`icon-192/512.png` | `apps/web/public/` | 全部平台 |

`[事实]` 已实际查看 `apps/web/public/favicon.png`：橙色圆润小机器人 + 深色圆角底（128×128）。这与登录页的两根竖条标志不是同一个图形（`apps/web/src/pages/Auth.tsx:568-571`），当前品牌图形本身就不统一。

### 6.2 应用内可见的 "Rakazo" 文案（已验证，非穷举）

| 界面 | 文案 | 证据 |
| --- | --- | --- |
| 登录 / 注册 | `Sign in to Rakazo` / `Create your Rakazo` | `apps/web/src/pages/Auth.tsx:62-71` |
| 登录页图形标志 | 74px 圆形 + 两根 9px 竖条 | `apps/web/src/pages/Auth.tsx:568-571` |
| 分享页 / 公开页 | `Open Rakazo`、`Return to Rakazo` | `apps/web/src/components/pages/PublicPageShell.tsx:31`、`apps/web/src/pages/SharedPage.tsx:59`、`apps/web/src/pages/Invite.tsx:104` |
| OAuth 回调 | `Return to Rakazo` | `apps/web/src/pages/McpOAuthCallback.tsx:61`、`apps/web/src/pages/SlackInstallCallback.tsx:35` |
| 注册后问卷 | `Welcome to Rakazo` / `How will you use Rakazo?` | `apps/web/src/components/SignupSurvey.tsx:55-59,115` |
| 账号设置（Bot 风格） | `Original` / `Rakazo` 切换（avatar set 标签） | `apps/web/src/pages/AccountSettingsOverlay.tsx:303-307` |
| 模型积分 | `Choose how to use Rakazo` / `Use Rakazo credits` | `apps/web/src/components/ModelCredits.tsx:315,869` |
| 订阅付费墙 | `Choose how to use Rakazo` | `apps/web/src/components/SubscriptionGate.tsx:177` |
| GitHub 求星 toast | `Enjoying Rakazo?` | `apps/web/src/components/GitHubStarPrompt.tsx:60` |
| 麦克风/语音权限文案 | `Allow Rakazo to use Speech Recognition...` | `apps/web/src/lib/dictation.ts:347` |
| 运行错误（核心常量） | `...choose Rakazo credits in Billing.` | `packages/core/src/run-error.ts:36-38`、`apps/web/src/lib/run-error.ts:39-44` |
| 自更新提示（核心常量） | `Rakazo will exit after updating...` | `packages/core/src/self-update.ts:259-261` |
| 服务端配置错误 | `...before starting Rakazo...` | `packages/core/src/secrets-guard.ts:13` |

`[事实]` **主应用 shell 内没有**品牌 logo/wordmark：侧栏头部只有 `WindowChrome` spacer 和四个图标按钮（`apps/web/src/pages/shell/sidebar-header.tsx:45-150`）；唯一把图形当 logo 用的是公开分享页的 16px favicon（`apps/web/src/components/pages/PublicPageShell.tsx:30`、`apps/web/src/pages/SharedPage.tsx:51`）；`Wordmark` 组件（`packages/ui-web/src/bot-avatar.tsx:410-422`，硬编码文字 "Rakazo"）只在 `packages/ui-web/src/index.ts:11` 导出，`apps/web` 与 `apps/mobile` 均未引用。`apps/www` 里出现的 "Wordmark" 是品牌素材清单里的 SVG 条目名（`apps/www/src/brand.ts:12-16`、`Header.astro` 的复制按钮文案），不是这个组件。
`[建议]` RabbitBots 想要"品牌感"，最少要新增一个 shell 级 wordmark/lockup；不能直接复用 `Wordmark`（文字与图形都写死 Rakazo），需要改成接受 `name`/`mark` 的通用组件，或新建一个 RabbitBots 专属组件。

### 6.3 品牌资产生成流水线（已验证）

```
packages/ui-tokens/assets/Rakazo.icon/Assets/orange-bot.png   ← 唯一源图（1.34 MB）
        │
        └─ pnpm --filter @rakazo/ui-tokens export:brand        (packages/ui-tokens/package.json:14)
             └─ packages/ui-tokens/scripts/export-brand.ts:8,55-69
                  ├─ apps/web/public/favicon-16x16.png
                  ├─ apps/web/public/favicon-32x32.png
                  ├─ apps/web/public/favicon.png
                  ├─ apps/web/public/apple-touch-icon.png
                  ├─ apps/web/public/icon-192.png
                  ├─ apps/web/public/icon-512.png
                  ├─ apps/web/public/favicon.ico
                  ├─ apps/www/public/...（同一套）
                  ├─ apps/www/public/brand/rakazo-mark.png
                  ├─ apps/mobile/assets/favicon.png
                  ├─ apps/desktop/assets/icon.png / icon.ico
                  └─ apps/mobile/assets/splash-icon.png / notification-icon.png
```

- `[事实]` `Rakazo.icon` 是 Apple Icon Composer 源包（`packages/ui-tokens/assets/README.md:1-20`），由 Xcode 26+ 维护；`icon.json` + `Assets/orange-bot.png` 是其内容。
- `[事实]` 脚本依赖 `sharp`（`packages/ui-tokens/scripts/export-brand.ts:3`），在 WSL/Linux 上可以跑；但设计源是 macOS 专用格式。
- `[建议]` RabbitBots 换 favicon 有两条路：
  1. 设计侧产出新的 1024×1024 PNG，替换 `orange-bot.png` 并保持文件名（最小改动，但会污染 Rakazo 源）；
  2. 新增 `RabbitBots.icon` 源与脚本参数化（更正确，改动更大）。
  无论哪条，**不要手改 `apps/web/public/*.png`**，否则下次 `export:brand` 会被覆盖。

### 6.4 i18n 与测试耦合（已验证）

- `[事实]` 15 个语言目录：`apps/web/src/locales/{de,en,es,fr,he,hi,ja,ko,nl,pl,pt-BR,ru,tr,zh-CN,zh-TW}/messages.po`。
- `[事实]` `Rakazo` 在每个 catalog 中出现约 44–46 次；英文 catalog 有 42 处匹配（21 个唯一 msgid），见 `apps/web/src/locales/en/messages.po:881,1634,1971,2801,3288,3805,4932,4946,4950,5097,5276,5469,5473,5477,5514,5946,6457,7141,7502,7648,7660`。
- `[事实]` `apps/web/src/lib/i18n-catalog.test.ts:46` 断言西语必须翻译 `Allow Rakazo to use Speech Recognition...`；`:75` 断言多语言必须翻译 `...choose Rakazo credits in Billing.`。改这些 msgid 会直接让测试失败。
- `[事实]` `packages/core/src/run-error.ts:36-38` 的常量被 `apps/web/src/lib/run-error.ts:39-44` 按**精确字符串**匹配后翻译；改文案必须同时改两处 + `i18n-catalog.test.ts`。
- `[事实]` 仓库规范（`AGENTS.md`）：feature PR 只改代码中的 UI 字符串，不跑 `intl:extract`、不编辑翻译 catalog；翻译走单独的 catalog 更新流程。这意味着 **1B-2 若只改英文源码，其他语言会回退到英文，但不会崩**。
- `[建议]` 演示只要英文；先把 `?lang` / 浏览器语言锁定为 `en`（`apps/web/src/lib/ui-locale.ts`），避免机器语言导致中文/日文界面。

### 6.5 Web 之外的品牌面（已验证，本阶段不处理）

| 面 | 当前值 | 证据 |
| --- | --- | --- |
| Electron productName | `Rakazo` | `apps/desktop/package.json:3` |
| Electron appId | `dev.rakazo.desktop` | `apps/desktop/package.json:41` |
| Electron 图标 | `packages/ui-tokens/assets/Rakazo.icon` | `apps/desktop/package.json:69` |
| Electron 首次设置页 | `Set up Rakazo` / `Welcome to Rakazo` / `Rakazo Cloud` | `apps/desktop/src/setup.html:9,15,20,29` |
| Electron 菜单 | `Change Rakazo Server…` / 更新文案 | `apps/desktop/src/app-menu.ts:31,57,106` |
| Electron 窗口底色 | 硬编码 `#0A0A0A`（与 `webDarkTokens.background` 同步，测试断言） | `apps/desktop/src/window-options.ts:15-18`、`apps/desktop/src/window-options.test.ts:111-114` |
| Expo app 名 | `Rakazo` | `apps/mobile/app.json:3` |
| iOS 权限文案 | 多处 `Rakazo ...` | `apps/mobile/app.json:111` 等 |
| 官网品牌 kit | `rakazo-logo.png` / `rakazo-wordmark.svg` / `rakazo-icon.png` / 8 个 job-bot 头像 | `apps/www/public/brand/kit/`、`apps/www/src/brand.ts:1-35` |
| 官网 Logo 组件 | `/brand/rakazo-mark.png` + 文字 `rakazo` | `apps/www/src/components/Logo.astro:10-20` |
| 官网 manifest | name `Rakazo` | `apps/www/public/site.webmanifest:1-12` |

`[事实]` 右侧栏若要"白色 macOS"，在 Electron 里还会遇到窗口底色 `#0A0A0A` 的问题（`apps/desktop/src/window-options.ts:18`），浏览器演示不受影响。
`[建议]` 1B-1/1B-2 只做 Web 演示面：`index.html` 标题/图标 + 登录页文案 + 新增 shell wordmark。Electron/mobile/www 的改名放到独立阶段，避免一次触碰 4 个平台。

---

## 7. 现有可复用组件

### 7.1 `@rakazo/ui-web`（已验证）

统一导出在 `packages/ui-web/src/index.ts:1-60`。与三栏改造直接相关的：

| 组件 / API | 用途 | 证据 |
| --- | --- | --- |
| `SidebarProvider` / `Sidebar` | 左栏容器、桌面 gap、移动端 Sheet | `packages/ui-web/src/components/ui/sidebar.tsx:49-226` |
| `Button`（含 `variant="floating"`） | 聊天顶部浮动按钮、侧栏图标按钮 | `packages/ui-web/src/components/ui/button.tsx`、`apps/web/src/pages/shell/chat-header.tsx:47-62` |
| `Tabs` | BotSettings 的 Computer/Routines/Pages/Advanced | `apps/web/src/pages/shell/bot-panel.tsx:530-555` |
| `ContextMenu` | Roster 右键菜单 | `apps/web/src/pages/shell/sidebar-roster.tsx:548-579` |
| `Collapsible` | Roster 分组折叠 | `apps/web/src/pages/shell/sidebar-roster.tsx:126-134` |
| `InputGroup` | 侧栏搜索框 | `apps/web/src/pages/shell/shell-sidebar.tsx:199-249` |
| `Tooltip` / `IconTooltip` | 图标按钮说明 | `apps/web/src/components/IconTooltip.tsx` |
| `SectionHeading` | 设置/面板标题统一 | `packages/ui-web/src/section-heading.tsx` |
| `BotAvatar` / `GroupAvatar` | 身份头像（唯一身份色） | `bot-avatar.tsx`、`group-avatar.tsx` |
| `LogoAvatar` | 生成式矢量头像 | `logo-avatar.tsx` |
| `Wordmark` | 品牌字标（当前硬编码 Rakazo） | `packages/ui-web/src/bot-avatar.tsx:410-422` |
| `Spinner` / `Skeleton` / `Empty` | 加载/空态 | `packages/ui-web/src/components/ui/spinner.tsx` 等 |
| `ResizableSidePanel`（app 内） | 右栏宽度拖拽 + 持久化 | `apps/web/src/pages/ResizableSidePanel.tsx` |

`[事实]` 规范要求 Web 用 shadcn on Base UI 并 vendored 到 `packages/ui-web`，不要手写已有 chrome（`AGENTS.md`）。

### 7.2 应用内复用件（已验证）

| 需求 | 可复用件 | 位置 |
| --- | --- | --- |
| AI 加载 / 成功反馈 | `LoadingState`、`Shimmer`、`SuccessPop`、`BuiCard` | `apps/web/src/components/ai/primitives.tsx:12-128` |
| 多 bot 协作标记 | `CollaborationMarker`、`ActiveBotGlyph` | `apps/web/src/components/ai/CollaborationMarker.tsx:6,45` |
| 屏幕渲染 | `screenFrames`、`screenIframeSandbox`、`embeddableScreenUrl` | `apps/web/src/pages/shell/computer-panel.tsx:8`、`apps/web/src/lib/computer-screen.ts:33-57,119-134` |
| Computer 空态/错误/开机态 | `computerPlaceholder`、`computerLabel`、`DesktopKindEmptyState` | `apps/web/src/pages/shell/computer-view.tsx:5-29` |
| 右栏宽度 | `ResizableSidePanel`（320 最小、384 默认、1000 上限、localStorage） | `apps/web/src/pages/ResizableSidePanel.tsx:6-10,29-82` |
| 右栏内容 | `BotSettings`、`GroupSettings`、`RoutineEditor`、`AgentImportForm` | `apps/web/src/pages/shell/side-panel.tsx:140-233` |
| 空 bot 状态 | "New bot" 按钮 | `apps/web/src/pages/Shell.tsx:1079-1086` |
| 标准文案/图标 | `lucide-react`（全仓统一） | `package.json`、各组件 import |

### 7.3 设计 token / 样式（已验证）

- `[事实]` 语义 token 唯一来源是 `packages/ui-tokens/src/index.ts`，生成 `tokens.css`（文件头注释 `packages/ui-tokens/src/tokens.css:1`）。禁止硬编码产品 hex（`AGENTS.md`）。
- `[事实]` 亮色值：`background #ffffff`、`card #f2f2f2`、`muted #f2f2f2`、`sidebar #f5f5f5`、`border #1c1c1c1f`、`radius 0.75rem`（`packages/ui-tokens/src/tokens.css:60-114`）。
- `[事实]` 字体：`-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`（`packages/ui-web/src/styles.css:13`），macOS 常规字重 420（`packages/ui-web/src/styles.css:43-46`、`apps/web/public/theme.js:16-20`）。
- `[事实]` 字号是一套受限 scale（caption 11 → display 32），不允许 off-scale 值，除非注释说明（`packages/ui-web/src/styles.css:9-41`、`apps/web/src/type-scale.test.ts`）。
- `[建议]` "白色 macOS 企业 SaaS"不需要新 token：强制 light + 现有 sidebar/background/border 就是目标观感；任何新的品牌色（如果 RabbitBots 有）应加在 `ui-tokens` 的语义槽位里，而不是散落组件。

---

## 8. 三栏布局最小实现方案

> 本节全部为 `[建议]`，1B-1 未实施。目标：左 Bot Roster（三固定 bot）、中独立 Chat、右常驻 Computer Workspace、白色 macOS 观感。

### 8.1 现状能力与缺口

| 能力 | 现状 | 证据 |
| --- | --- | --- |
| 三栏 DOM/CSS | 已有；右栏在 `md+` 参与 flex | `apps/web/src/pages/Shell.tsx:920-1207`、`apps/web/src/pages/ResizableSidePanel.tsx:76-82` |
| 右栏默认打开 | 否，`panel` 初始 `null` | `apps/web/src/pages/shell/use-right-panel.ts:20` |
| 右栏默认内容是 Computer | 否，`lastBotTab = "routines"` | `apps/web/src/pages/Shell.tsx:201,419-428` |
| 右栏常驻 | 否，可关闭、按 chat 恢复 | `apps/web/src/pages/shell/side-panel.tsx:129-136`、`apps/web/src/pages/shell/use-right-panel.ts:124-158` |
| 右栏内容=Computer 且无 Tab chrome | 否，Computer 是 BotSettings 的 Tab | `apps/web/src/pages/shell/bot-panel.tsx:530-555` |
| 实时屏幕 | 有，但被 `panel/computerOpen` gate | `apps/web/src/pages/shell/use-computer.tsx:379` |
| Computer 自动开机 | 有（打开 Tab 时） | `apps/web/src/pages/shell/use-computer.tsx:673-703` |
| 窄屏降级 | 有（右栏覆盖） | `apps/web/src/pages/ResizableSidePanel.tsx:42` |
| 品牌 wordmark | 无 | `apps/web/src/pages/shell/sidebar-header.tsx:45-150` |

### 8.2 尺寸预算（按当前默认宽度计算，已验证公式）

默认左栏 316px、右栏 384px；右栏在 `viewport - 左栏 < 640` 时改为覆盖（`apps/web/src/pages/ResizableSidePanel.tsx:12-17,42`）。

| 视口宽 | 左栏 | 右栏 | 中间 Chat | 结果 |
| --- | --- | --- | --- | --- |
| 1512 | 316 | 384 | 812 | 舒适 |
| 1440 | 316 | 384 | 740 | 推荐最小演示宽 |
| 1366 | 316 | 384 | 666 | 可用 |
| 1280 | 316 | 384 | 580 | 偏紧但可演示 |
| 1200 | 316 | 384 | 500 | 紧 |
| 1100 | 316 | 384 | 400 | 很紧 |
| 1024 | 316 | 384 | 324 | 接近极限 |
| 1000 | 316 | 364（被 max 压窄） | 320 | 极限 |
| 956 | 316 | 320 | 320 | 三栏临界点 |
| ≤955 | 316 | 覆盖式 320 | 639（被盖住） | 退化为两栏 |

`[建议]` 演示机窗口/浏览器至少 1440×900；若只能 1280，建议把左栏设为 mini（72px）或把右栏降到 340–360px，中间可回到 604–648px。

### 8.3 三种实现路径

#### 方案 A：把现有右栏默认成 Computer（最小改动）

改法：

1. `useRightPanelRestore` 在"该 chat 没有保存状态"时返回 `"computer"` 而不是 `null`（`apps/web/src/pages/shell/use-right-panel.ts:136-157`）。
2. `lastBotTab` 初值改为 `"computer"`（`apps/web/src/pages/Shell.tsx:201`）。
3. `side-panel.tsx` 在 `panel === "computer"` 时隐藏关闭按钮并忽略关闭（`apps/web/src/pages/shell/side-panel.tsx:129-136`）。

优点：改动约 20–40 行；复用全部现有逻辑（宽度、拖拽、持久化、屏幕、boot）。
缺点：
- 右栏仍带 BotSettings 的 profile 头和四个 Tab（`apps/web/src/pages/shell/bot-panel.tsx:500-555`），不是干净的 Workspace。
- 点设置/例程会把 Computer 换掉，不符合"常驻"。
- 切换 bot 仍会按各 chat 的记忆切换/关闭。
- 打开即自动开机（`apps/web/src/pages/shell/use-computer.tsx:673-703`）。

适用：只求"演示时右栏看起来是 Computer"的临时方案；不推荐作为 1B-2 的最终形态。

#### 方案 B：单轨双层——Computer 作为右栏底座，设置以覆盖层出现（推荐给 demo）

改法：

1. 新增 `ComputerWorkspace` 作为右栏底座：bot active 且宽屏时始终挂载在 `main` 之后；薄 header（`computerLabel` + 展开按钮 + 可选收起）+ 屏幕/空态/错误/开机态。屏幕渲染复用 `screenFrames`（`apps/web/src/lib/computer-screen.ts:119`），空/错/开机复用 `apps/web/src/pages/shell/computer-view.tsx` 与 `computerControls` 的节点。
2. `ShellSidePanel` 保留现有职责（settings / routines / pages / group-settings / import-agent / routine），但改成 `absolute inset-y-0 end-0` 的覆盖层（带阴影、更高 z-index）。打开设置时盖住底座，关闭后露出 Computer。
3. `Panel` 里的 `computer` 取值不再承担“显示 Computer”的职责（可保留用于兼容或“聚焦底座”）；`useRightPanelRestore` 不需要默认 `"computer"`，也不需要在切 bot 时 restore 右栏。
4. `use-computer.tsx` 的 `computerVisible` 增加底座可见性；auto-boot 改成显式 Wake 或“首次进入该 bot 时一次”，避免切 bot 自动开机。
5. 宽屏底座复用 `ResizableSidePanel` 的宽度逻辑（320–1000、localStorage）；覆盖层沿用现有宽度与拖拽。

优点：满足“右侧常驻”的视觉承诺；Computer 与设置可以共存（设置只是盖住）；复用现有宽度/拖拽/屏幕/错误态；不改 `Panel` 的其它取值。
缺点：要动 `ResizableSidePanel` 的布局模式与 `use-computer` 的 gate；窄屏必须隐藏底座；需要新写一个薄 Workspace 壳。
预计 diff：~150–220 行 + 测试更新。

#### 方案 C：真正的并排双右栏（演示后）

改法：Workspace 作为独立 flex 子项常驻；`ShellSidePanel` 永远 absolute 覆盖（或变成第二右栏）；`computerVisible` 永远包含 Workspace；心跳与自动开机策略独立；移动端隐藏 Workspace。
优点：严格满足"常驻 + 设置可同时打开"。
缺点：中间 Chat 再被压缩 320–384px；窄屏不可用；要改 `apps/web/e2e/golden.spec.ts:87`（断言 main 右边界 ≤ panel 左边界）与 `resizable-side-panel.spec.ts` 全部宽度断言；测试与布局风险最高。

### 8.4 推荐路径

`[建议]` **1B-2 用方案 B，1B-3 再评估方案 C。** 分步：

1. **底座挂载**：在 `apps/web/src/pages/Shell.tsx` 的 `BotsSidebarLayout` 内、`main` 之后新增 `<ComputerWorkspace>`（`active && !inGroup` 且宽屏时渲染）；`ShellSidePanel` 移到它后面，作为覆盖层。
2. **底座内容**：复用 `ComputerPanel` 的屏幕/空态/错误/开机节点，新增一个薄 header；不要复用 `BotSettings` 的 profile 与 Tabs。
3. **屏幕可见性**：`apps/web/src/pages/shell/use-computer.tsx:378-379` 改为 `panel === "computer" || computerOpen || workspaceVisible`；`refreshComputerScreen` 的 gate 同步（`:419-420`）。
4. **开机策略**：如果保留自动开机，用现有 `autoBooted` ref（`apps/web/src/pages/shell/use-computer.tsx:606,691-692`）保证每个 bot 只自动开一次；更稳的做法是演示前手动 Wake 一次，避免冷启动等待。
5. **设置覆盖层**：给 `ResizableSidePanel` 加 `overlay` prop，Settings/Routines/Pages 打开时 `absolute` + 阴影 + 更高 z-index；`data-overlay` 已有（`apps/web/src/pages/ResizableSidePanel.tsx:79`），只需让 `overlay` 不再只由宽度计算决定。
6. **宽度与断点**：底座默认 380–420；`xl` 以下隐藏底座或退化为覆盖；移动端继续用现在的全屏 Computer。
7. **品牌**：在 `apps/web/src/pages/shell/sidebar-header.tsx:49-50` 的 72px spacer 之后插入 RabbitBots wordmark（新组件或泛化 `Wordmark`），不改 `Sidebar` 结构。

### 8.5 右栏内容设计建议

`[建议]` 常驻栏只保留三类信息：

- **标题行**：`computerLabel(computer.mode, bot.name)`（`apps/web/src/pages/shell/computer-view.tsx:27-29`）+ 状态（running / asleep / booting）+ 展开（全屏）按钮。
- **屏幕区**：运行中显示只读 iframe（复用 `screenFrames`）；空闲显示现有 "Asleep / Wake"（`apps/web/src/pages/shell/computer-panel.tsx:101-131`）；错误显示现有 `computerScreenError` 与 Retry（`apps/web/src/pages/shell/use-computer.tsx:861-912`）。
- **一个主动作**：`Wake` 或 `Open`（全屏）。不要在这个栏里放 `Take control`、`Release`、`Teach`、`Maintenance` 等全屏专属动作——它们会显著增加演示时的误操作面。

`[建议]` 不要在常驻栏里重复 BotSettings 的 profile（名称/头像/邮箱/描述）；那些属于"设置"，应留在覆盖层里。

### 8.6 数据与外观准备（不改 DB / Schema）

| 项 | 做法 | 证据 |
| --- | --- | --- |
| 三个 Bot | 通过 `bots/create` RPC（或 UI 新建后改名）创建 `CEO Assistant`、`Research Bot`、`Finance Bot` | `packages/contracts/src/domain.ts:445-465`；e2e 同样用 `bots/create`（`apps/web/e2e/helpers.ts:319-325`） |
| 描述/指令 | `CreateBotInput` 直接接受 `description`/`instructions`；UI 弹窗不收，需走 RPC 或设置 | `packages/contracts/src/domain.ts:452-453`、`apps/web/src/pages/shell/create-bot-dialog.tsx:24-31` |
| 电脑模式 | `computerMode: "private"` 让每个 bot 有独立电脑；默认 `team` 会共用 | `packages/contracts/src/domain.ts:462`、`docs/computer.md:27-35` |
| 颜色 | `color` 从 `BOT_COLOR_LIST` 选（白、紫、绿、橙…），确保三个 bot 可区分 | `packages/contracts/src/bot-avatar.ts:22-60` |
| 处理 Chief | onboarding 会自动建 `Chief`（`apps/web/src/pages/onboarding/first-bot.tsx:5`）；可改名成 CEO Assistant，或新建三个后 archive 它（`apps/web/src/pages/shell/chat-context-menu.tsx:113-119`） | 同左 |
| Space 名 | 默认 `Personal`（`packages/db/src/bootstrap-user.ts:112`）；用 Space 菜单改名 `RabbitBots`，它会成为 Roster 分组头 | `apps/web/src/pages/shell/space-sidebar.ts:96`、`apps/web/src/pages/shell/use-space-actions.ts:25-37` |
| 外观 | 设置 → Appearance → Light（`apps/web/src/pages/AccountSettingsOverlay.tsx:262-268,790-820`），或直接写 `localStorage["rakazo.uiAppearance"]="light"` | `packages/ui-tokens/src/index.ts:7`、`apps/web/public/theme.js:2-12` |
| 求星 toast | 发满 5 条消息后会出现 "Enjoying Rakazo?"（`apps/web/src/components/GitHubStarPrompt.tsx:9,20-40`）；演示前写 `localStorage["rakazo.githubStarPrompt.dismissed"]="1"` | 同左 |
| Passkey 提示 | 新账号首会话可能出侧栏提示（`apps/web/src/components/PasskeyOffer.tsx:46-68`）；提前点掉或使用老账号 | 同左 |
| 计费门 | 计费部署下无 access 会进 Paywall（`apps/web/src/App.tsx:277-286`）；确认演示账号有 access | 同左 |

`[建议]` 不要为了演示去改数据库或 Prisma schema；三个 bot 是普通业务数据，走 API 即可。也不要把三个名字硬编码进 Roster 组件——那会破坏多 space/多 bot 的既有能力。

### 8.7 需要同步更新的测试（[建议]）

| 测试 | 会受什么影响 | 证据 |
| --- | --- | --- |
| `apps/web/e2e/resizable-side-panel.spec.ts` | 断言右栏默认 384px、可拖到 >600、窄屏隐藏 | `apps/web/e2e/resizable-side-panel.spec.ts:4-59` |
| `apps/web/e2e/golden.spec.ts` | 断言 `main` 右边界 ≤ panel 左边界；右栏 `data-panel="computer"`、384px | `apps/web/e2e/golden.spec.ts:72-87` |
| `apps/web/e2e/chat-header.spec.ts` | 断言 header 浮在 transcript 上；截图 light/dark | `apps/web/e2e/chat-header.spec.ts:4-47` |
| `apps/web/e2e/transcript-width.spec.ts` | 断言 720px 宽也不横向滚动 | `apps/web/e2e/transcript-width.spec.ts:24-45` |
| `apps/web/e2e/sidebar-*.spec.ts` | 侧栏宽度/折叠/密度 | `sidebar-mini-resize`、`sidebar-density`、`sidebar-search` |
| `apps/web/e2e/computer-*.spec.ts` | 右栏 Computer 的打开/截图/boot 行为 | `computer-screen`、`computer-boot-leave`、`computer-disk-warning` 等 |
| `apps/web/src/pages/shell/*.test.tsx` | `use-computer`、`bot-panel` 等单测 | 同目录 |

`[建议]` 先改单测（如 `use-computer.test.tsx`），再改 e2e；e2e 的 384px 与 `data-panel` 断言是硬编码的，布局一变就会红。

### 8.8 不建议的做法

- `[建议]` **不要把三个 bot 写死进 Roster**。Roster 由 `spaces.list` 驱动，写死会与 onboarding、chat 创建、space 切换、e2e 全部冲突。
- `[建议]` **不要新写一套 Chat**。`Transcript`/`Composer` 承载了流式、未读、引用、附件、mention、斜杠命令、语音、computer card 等大量行为（`apps/web/src/pages/shell/composer.tsx:1-67`、`apps/web/src/pages/shell/transcript.tsx:1-53`），重写成本远超布局收益。
- `[建议]` **不要用绝对定位硬贴一个"假右栏"**。现有 `ShellSidePanel` 已经处理宽度、拖拽、持久化、窄屏覆盖，绕开它会产生第二套 layout 逻辑。
- `[建议]` **不要动 `Authorization` 边界/space 切换逻辑**。切换 space 会整壳重挂载（`apps/web/src/pages/Shell.tsx:120-124`），新栏必须能承受 remount。
- `[建议]` **不要为了让右栏常驻而删除 `Panel` 的其它取值**（routines/pages/settings/group-settings/import-agent/routine）。它们各自有真实入口（`apps/web/src/pages/Shell.tsx:371-397`、`apps/web/src/pages/shell/chat-context-menu.tsx:95-124`）。

---

## 9. 待浏览器验证事项

> 以下必须在真实 dev server + 浏览器里确认；本阶段未启动服务，全部为 `[待验证]`。

| # | 要验证什么 | 怎么验证 | 期望 / 风险 |
| --- | --- | --- | --- |
| 1 | dev server 能起来，端口正确 | 在 WSL 内 `pnpm dev`；确认 web 5173、api 3100、Postgres 映射 55450 | `scripts/dev.mjs:43-54,97-106`；web/api/supervisor 会自动选空闲 block，但 Postgres 映射端口固定为 55450（`scripts/dev.mjs:171`） |
| 2 | 演示账号能进 `/app` | 登录后看是否落在 `/app/<botId>`，不是 `/onboarding` | `apps/web/src/pages/shell/use-space-roster.ts:117-129` 会在无内容时重定向 |
| 3 | Roster 实际标题 | 三 bot 且单 space 时，侧栏顶部是否显示 "Personal" | `apps/web/src/pages/shell/space-sidebar.ts:96`、`packages/db/src/bootstrap-user.ts:112` |
| 4 | 三个 bot 的实际顺序 | 创建后 Roster 顺序是否 CEO → Research → Finance | `packages/db/src/repos.ts:360-376` 按 position/createdAt |
| 5 | 右栏首次点击行为 | 点聊天标题，打开的是 Routines 还是 Computer | `apps/web/src/pages/Shell.tsx:201,419-428` |
| 6 | 切换 bot 后右栏状态 | 是否关闭/变成该 bot 上次的 Tab | `apps/web/src/pages/shell/use-right-panel.ts:124-158` |
| 7 | 右栏宽度与拖拽 | 1440 宽下 384px；拖动后刷新是否记住 | `apps/web/src/pages/ResizableSidePanel.tsx:6-10,47-53` |
| 8 | 三栏临界宽度 | 缩到 ~956/955px，右栏何时从挤压变覆盖 | `apps/web/src/pages/ResizableSidePanel.tsx:42` |
| 9 | Computer 屏幕是否可用 | 打开 Computer Tab，看是桌面还是 "unavailable" 提示 | `apps/web/src/lib/computer-sandbox.ts:6-8`；取决于 `SANDBOX_PROVIDER` |
| 10 | 自动开机耗时/成本 | 打开 Computer Tab 后记录从 boot 到有屏幕的时间 | `apps/web/src/pages/shell/use-computer.tsx:673-703`；真实 sandbox 可能 30s+ |
| 11 | 三个 bot 的电脑是否同一台 | team 模式下依次打开三个 bot 的 Computer，看标题与内容 | `apps/web/src/pages/shell/computer-view.tsx:27-29`、`packages/contracts/src/domain.ts:462` |
| 12 | 全屏 Computer 与切换 bot | 全屏时按 Ctrl+Tab 切 bot，是否自动关闭全屏 | `apps/web/src/pages/shell/use-computer.tsx:705-710` |
| 13 | Light 主题观感 | Appearance → Light；截图检查白底、侧栏、边框、hover | `packages/ui-tokens/src/tokens.css:60-114` |
| 14 | 浏览器语言 | 新 profile / 系统中文时，界面是否中文；演示是否要强制 en | `apps/web/src/lib/ui-locale.ts` |
| 15 | 求星 toast | 发 5 条消息是否弹 "Enjoying Rakazo?" | `apps/web/src/components/GitHubStarPrompt.tsx:9,20-40` |
| 16 | Passkey 提示 | 新账号首会话侧栏是否出现提示 | `apps/web/src/components/PasskeyOffer.tsx:46-68` |
| 17 | favicon / title 改动生效 | 改 `index.html` 后强刷，标签页标题与图标是否更新 | 浏览器 favicon 缓存较顽固，需硬刷新 |
| 18 | PWA manifest | DevTools → Application → Manifest 是否显示新 name/图标 | `apps/web/src/pwa/plugin.ts:20-22,81-91` |
| 19 | Electron（可选） | 打开桌面端，首次设置页/窗口标题/底色 | `apps/desktop/src/setup.html:9-29`、`apps/desktop/src/window-options.ts:18` |
| 20 | 右栏 long-run 稳定性 | Computer 栏常驻 10 分钟，看屏幕是否掉线/重连 | `apps/web/src/pages/shell/use-computer.tsx:165-358` 的重连逻辑 |
| 21 | 切 bot 后的滚动位置 | 在 A bot 滚到中部 → 切 B → 切回 A，看 Transcript 位置 | `apps/web/src/pages/Shell.tsx:1088` 以 threadId 为 key；当前行为未在源码中断言 |

---

## 10. 风险与未知

1. `[待验证]` **Sandbox 可用性未知**：未读取 `.env`。`SANDBOX_PROVIDER=none/""` 时右栏只能是提示（`apps/web/src/lib/computer-sandbox.ts:6-8`）。演示前必须确认有一台能跑的 computer，否则"常驻 Computer Workspace"是空壳。
2. `[待验证]` **自动开机的真实耗时**：`bootComputer` 是真实 RPC（`apps/web/src/pages/shell/use-computer.tsx:634-636`），冷启动可能几十秒；演示脚本需要预留 Wake 时间。
3. `[事实]` **每个 chat 的右栏记忆是持久化的**：`writeRightPanelState` 写入 `localStorage`（`apps/web/src/lib/right-panel-state.ts:24-31,57-67`），演示机如果之前开过别的 Tab，首屏可能不是 Computer。演示前清 localStorage 或改默认值。
4. `[事实]` **全屏 Computer 会盖住所有内容**，包括侧栏与聊天（`apps/web/src/pages/shell/computer-overlay.tsx:79`）；演示时按 Esc 或 Close 才能回到三栏。
5. `[事实]` **品牌文案改动会碰测试**：`apps/web/src/lib/i18n-catalog.test.ts:46,75` 对特定字符串有硬断言；`packages/core/src/run-error.ts:36-38` 与 `apps/web/src/lib/run-error.ts:39-44` 之间有精确字符串匹配。改名必须成组改。
6. `[事实]` **图标流水线会覆盖手改文件**：`packages/ui-tokens/scripts/export-brand.ts:55-64` 会重写 `apps/web/public/*`。换标要改源，不要改产物。
7. `[事实]` **移动端布局完全不同**：<768px 侧栏是抽屉，右栏是覆盖层（`packages/ui-web/src/hooks/use-mobile.ts:3-5`、`apps/web/src/pages/ResizableSidePanel.tsx:42`）。三栏只在桌面成立，不要承诺移动端三栏。
8. `[建议]` **不要提交本报告之外的无关改动**。当前工作区的 37 个 mode-only 变更不是本任务产生的；如果最终要提交，应单独确认是否恢复文件模式。

---

## 附录 A：关键证据索引

| 主题 | 文件:行 |
| --- | --- |
| HTML 品牌面 | `apps/web/index.html:6-17` |
| 首屏主题 | `apps/web/public/theme.js:1-21` |
| JS 入口 / Provider | `apps/web/src/main.tsx:59-83` |
| 路由表 | `apps/web/src/App.tsx:181-300` |
| Shell 挂载 | `apps/web/src/pages/Shell.tsx:120-124` |
| 三栏骨架 | `apps/web/src/pages/Shell.tsx:919-930, 939-1026, 1029-1207, 1217-1306` |
| 右栏宽度 | `apps/web/src/pages/ResizableSidePanel.tsx:6-17, 29-82` |
| 右栏 Panel 联合类型 | `apps/web/src/lib/right-panel-state.ts:1-31` |
| 右栏 per-chat 恢复 | `apps/web/src/pages/shell/use-right-panel.ts:124-168` |
| 右栏关闭按钮 | `apps/web/src/pages/shell/side-panel.tsx:129-136` |
| 默认 Tab = Routines | `apps/web/src/pages/Shell.tsx:201, 419-428` |
| BotSettings Tab | `apps/web/src/pages/shell/bot-panel.tsx:530-555` |
| Computer 面板 | `apps/web/src/pages/shell/computer-panel.tsx:35-209` |
| Computer 全屏 | `apps/web/src/pages/shell/computer-overlay.tsx:78-257` |
| Computer 状态 | `apps/web/src/pages/shell/use-computer.tsx:57-515, 519-949` |
| 可见性 gate | `apps/web/src/pages/shell/use-computer.tsx:379, 419-420` |
| 自动开机 | `apps/web/src/pages/shell/use-computer.tsx:673-703` |
| 心跳 | `apps/web/src/pages/shell/use-computer.tsx:746-760` |
| 屏幕工具 | `apps/web/src/lib/computer-screen.ts:33-134` |
| Roster 行 | `apps/web/src/pages/shell/sidebar-roster.tsx:275-581` |
| Roster 分组 | `apps/web/src/pages/shell/space-sidebar.ts:42-147`、`packages/core/src/bot-sections.ts:10-54` |
| Bot 列表排序 | `packages/db/src/repos.ts:360-376` |
| 默认 space | `packages/db/src/bootstrap-user.ts:109-114` |
| 默认首 bot | `apps/web/src/pages/onboarding/first-bot.tsx:5, 27-33, 50-59` |
| Bot 创建契约 | `packages/contracts/src/domain.ts:445-465` |
| Chat header | `apps/web/src/pages/shell/chat-header.tsx:44-117` |
| Transcript | `apps/web/src/pages/shell/transcript.tsx:472-701` |
| Composer | `apps/web/src/pages/shell/composer.tsx:594-890` |
| 亮色 tokens | `packages/ui-tokens/src/tokens.css:60-114` |
| 字体/字号 | `packages/ui-web/src/styles.css:9-46` |
| Wordmark（未使用） | `packages/ui-web/src/bot-avatar.tsx:410-422` |
| 登录页标志 | `apps/web/src/pages/Auth.tsx:548-590` |
| 品牌图标源 | `packages/ui-tokens/assets/Rakazo.icon/Assets/orange-bot.png`、`packages/ui-tokens/scripts/export-brand.ts:8, 55-69` |
| PWA manifest | `apps/web/src/pwa/plugin.ts:12-34, 81-105` |
| 本地化规模 | `apps/web/src/locales/*/messages.po`、`apps/web/src/lib/i18n-catalog.test.ts:46, 75` |
| 桌面品牌 | `apps/desktop/package.json:3,41,69`、`apps/desktop/src/setup.html:9-29` |
| 移动品牌 | `apps/mobile/app.json:3,111,149` |
| 官网品牌 | `apps/www/src/brand.ts:1-35`、`apps/www/src/components/Logo.astro:10-20` |

## 附录 B：本次勘察使用的命令（只读）

```bash
git rev-parse --short HEAD
git status --porcelain=v1
git diff -- scripts/dev.mjs
git diff --name-only        # 38 个路径；37 个 mode-only，1 个内容改动
```

另外使用 `rg` / `Select-String` / `Get-ChildItem` 做符号与文件定位，并实际读取了 `apps/web/public/favicon.png` 以确认当前图标图形。未启动 dev server、未连接数据库、未运行测试。

## 附录 C：Git 状态（本报告完成后）

```
HEAD: 6c7e1bcc6 (main)

已修改（内容）:
  scripts/dev.mjs                         ← Postgres 端口 54318 → 55450（保留）

已修改（仅文件模式 100755 → 100644，共 37 个）:
  .agents/skills/pr-watch/pr-digest
  .agents/skills/pr-watch/pr-screenshots
  .github/scripts/apply-issue-triage.sh
  ...（infra/、scripts/ 下其余脚本）

新增（未跟踪，本阶段交付）:
  ?? docs/reports/            ← 内含 docs/reports/RABBITSBOTS-PHASE-1B-1-FRONTEND-DISCOVERY.md

HEAD 在本次勘察前后均为 6c7e1bcc6。
```

未执行 `git add` / `git commit` / `git push`；未修改任何业务源码、数据库或依赖。
