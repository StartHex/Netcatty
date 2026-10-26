# 数据库工作台接入内置窗口（终端标签式）改造设计

> 状态：设计待确认（尚未实现）
> 前置：`docs/designs/database-workbench-jdbc.md`（数据库工作台主体功能）
> 当前实现：数据库工作台以 `Dialog` 浮动窗口形式挂在 Vault 分区上（`components/databases/SqlWorkbench.tsx`），用户已明确不接受该形态。

---

## 0. 结论摘要

| 方案 | 形态 | 改动量 | 结论 |
| --- | --- | --- | --- |
| **A（推荐）** | 数据库连接成为**顶层工作标签**，与终端/工作区/编辑器/插件视图并列，占用主区域 | 中（新增 tab store + surface + 关闭/快捷键/入口接线，约 4–6 人日） | **采用** |
| B | 数据库成为 **workspace pane**，可与终端左右分屏 | 大（`WorkspaceNode` 需要从"只装 sessionId"扩成内容联合类型，终端层、分屏、会话恢复、拖拽全部要改，约 12–18 人日） | 本期不做，留扩展点 |
| C | 独立 `BrowserWindow` 数据库窗口 | 中 | 不符合"内置窗口"诉求 | 

推荐 A：用户在顶部标签栏看到 `数据库图标 + 连接名` 的标签，点击即切换；工作台铺满主区域（和终端、Vault、编辑器一样），没有任何遮罩层。分屏能力本期不做，后续若需要再按 B 扩展。

---

## 1. 背景与诉求

用户原话（历史）：

> "我试了下这肯定不行 你先设计下加到内置窗口改造内容吧"

具体不满意点（结合上一版实现推断）：

1. `Dialog` 有遮罩、居中、离开即关，无法和终端并排使用；
2. 无法像终端标签那样在顶部标签栏切换、关闭、按 `Cmd+1..9` 跳转；
3. 关掉窗口后 SQL 草稿、结果、连接全部丢失；
4. 连接生命周期绑在对话框挂载上，切走就断开。

目标形态参照**终端标签**：顶部标签栏一个标签、主区域一个完整工作面、切走保留状态、关闭才释放连接。

---

## 2. 现状勘察（代码事实）

### 2.1 顶层标签是怎么组织的

- `application/state/activeTabStore.ts:8` 定义了标签 id 前缀机制，现有：`'vault'`、`'sftp'`、终端 `sessionId`、工作区 `workspaceId`、`editor:`（编辑器）、`plugin-view:`（插件视图）。
  - `toEditorTabId` / `isEditorTabId`（:11–:14）就是"前缀 + 内部 id"的范式。
- 顶部标签的完整顺序由 `application/app/AppSideEffects.tsx:1049-1062` 组装：
  ```ts
  const additionalWorkTabIds = useMemo(
    () => [...editorTabTopIds, ...pluginViewTabIds],
    [editorTabTopIds, pluginViewTabIds],
  );
  const orderedTabsWithEditors = useMemo(
    () => getOrderedWorkTabs(additionalWorkTabIds),
    [additionalWorkTabIds, getOrderedWorkTabs],
  );
  ```
  **新增一类工作标签的标准做法就是往 `additionalWorkTabIds` 里加一串 id**，其余（拖拽排序、编号快捷键、邻居计算）自动生效。
- `components/TopTabs.tsx` 按前缀分发渲染：`:837` `<EditorTopTab>`、`:865` `<PluginViewTopTab>`，各自带图标、标题、关闭按钮、中键关闭。

### 2.2 非终端surface 的现成范式

**编辑器标签**（最接近的样板）：

- `application/state/editorTabStore.ts:16-42`：`EditorTab { id, kind:'editor', sessionId, remotePath, content, baselineContent, viewState, savingState, placement }`，store 是 `useSyncExternalStore` + 订阅者模式；
- 打开入口在 `components/sftp/hooks/useSftpViewFileOps.ts`，通过 `toEditorTabId` 激活；
- 关闭走 `AppHandlers.handleRequestCloseEditorTab`（脏文件确认）。

**插件视图标签**：

- `application/state/pluginViewTabStore.ts`：`PluginViewTab { id, pluginId, viewId, title, icon, context }`；
- `components/plugins/PluginContributionHost.tsx:57-62`：`location === 'tab'` 时渲染
  ```tsx
  <section className="absolute inset-0 z-40 bg-background flex flex-col">
    <div ref={mountRef} className="min-h-0 flex-1" />
  </section>
  ```
  即**铺满主区域**的 surface。

**Vault surface 的显隐范式**（保留状态的关键）：

- `application/app/AppMounts.tsx:13-57` `VaultViewContainer`：
  ```ts
  const containerStyle = isActive ? {} : { visibility: 'hidden', pointerEvents: 'none', position: 'absolute', zIndex: -1 };
  ```
  非激活时**不卸载**，只隐藏 —— 这是"切走保留 SQL/结果/滚动位置"的现成做法。

### 2.3 当前数据库工作台的实现

- `components/databases/SqlWorkbench.tsx`：`Dialog` 包裹，内部 `useDatabaseWorkbench(connections, tunnelDeps)` 自持全部状态（tabs / sql / result / running）；
- 打开入口在 `components/vault/VaultViewLayout.tsx`（`workbenchConnection` state + `<SqlWorkbench open={...}>`），由 `DatabasesManager` 的 `onOpenConnection` 触发；
- 状态全部在组件内，**对话框一关就没了**。

### 2.4 关闭与快捷键路径

- 批量关闭：`application/app/AppHandlers.ts:776 closeTabsBatchImpl` —— 按 id 分类处理 session / workspace / logView / editor / pluginView，未知 id 直接忽略；
- 单键关闭：`executeHotkeyActionImpl` 的 `'closeTab'` 分支（:857 起）：`isPluginViewTabId` / `isEditorTabId` 特判，其余当 session/workspace 处理；
- 关闭后焦点回退：`resolveBatchTabCloseFocus`（`application/state/pluginViewTabStore.ts:29`）。

### 2.5 workspace pane 为什么不能直接塞数据库

`domain/models/workspace.ts:12-27`：

```ts
export type WorkspaceNode =
  | { id: string; type: 'pane'; sessionId: string }
  | { id: string; type: 'split'; direction: 'horizontal' | 'vertical'; children: WorkspaceNode[]; sizes?: number[] };
```

pane 只有 `sessionId`，且下游（`TerminalLayer`、分屏渲染、布局持久化、拖拽、会话恢复）全部假设 pane 内容是终端会话。要支持"数据库 pane"，得把它扩成 `content: { kind: 'terminal' | 'database', id }` 并改所有消费者 —— 见方案 B 成本。

---

## 3. 目标与非目标

**目标**

1. 数据库连接以**顶层标签**形式存在，与终端标签同栏、同排序、同快捷键；
2. 工作台铺满主区域，无遮罩、无 Dialog；
3. 切到别的标签再切回来，SQL、结果集、当前页、表结构展开状态**全部保留**，连接**不断开**；
4. 关闭标签才释放连接；事务未提交时关闭要确认；
5. 打开方式：Vault → 数据库列表的"打开"、双击卡片、右键菜单、QuickSwitcher；
6. 同一个连接可以开多个标签（像终端一样），标签标题可重命名。

**非目标（本期）**

- 数据库 pane 参与 workspace 分屏（方案 B）；
- 独立 OS 窗口；
- 多结果集并行（保持每标签串行）。

---

## 4. 方案对比

见 §0 表格。补充说明：

- **A** 复用 `editor:` / `plugin-view:` 的全部机制（前缀 id、TopTabs 渲染、`additionalWorkTabIds`、surface 显隐），风险集中在"状态从组件内提升到 store"。
- **B** 才是真正"像终端一样能左右分屏"，但 `WorkspaceNode` 改动会波及 `domain/workspace.ts`、`components/TerminalLayer*`、布局持久化、拖拽、会话恢复、AI workspace scope 等十几个模块，回归面积大。
- **C** 与"内置窗口"诉求相反。

---

## 5. 方案 A 详细设计

### 5.1 数据模型：`databaseTabStore`

新增 `application/state/databaseTabStore.ts`（模式抄 `editorTabStore`）：

```ts
export const DATABASE_TAB_PREFIX = 'database:';
export const toDatabaseTabId = (tabId: string) => `${DATABASE_TAB_PREFIX}${tabId}`;
export const isDatabaseTabId = (id: string) => id.startsWith(DATABASE_TAB_PREFIX);
export const fromDatabaseTabId = (id: string) => id.slice(DATABASE_TAB_PREFIX.length);

export interface DatabaseWorkbenchTab {
  id: string;                 // db_<uuid>
  kind: 'database';
  connectionId: string;       // 指向 DatabaseConnection
  title: string;              // 默认取 connection.label，可重命名
  sql: string;                // SQL 草稿（持久化）
  status: 'idle' | 'connecting' | 'ready' | 'error';
  serverVersion?: string;
  error?: string;
  transactionOpen?: boolean;
  lastActiveAt: number;
  // 运行态（不持久化）：result / running / errorDetail / durationMs
}
```

Store API：

```ts
class DatabaseTabStore {
  getTabs(): readonly DatabaseWorkbenchTab[];
  getTab(id): DatabaseWorkbenchTab | undefined;
  open(connection: DatabaseConnection, options?: { activate?: boolean }): string; // 返回 tabId
  close(id): void;
  update(id, patch): void;                 // sql / title / status / transactionOpen
  setRuntime(id, runtime): void;           // result / running / error / durationMs（不落盘）
  subscribe(listener): () => void;
}
export const databaseTabStore = new DatabaseTabStore();
export function useDatabaseTabs(): readonly DatabaseWorkbenchTab[];
```

**为什么状态要放 store**：surface 会被隐藏但保持挂载，可如果用户切到终端、再打开另一个连接，工作台要能同时存在多个 tab；组件内 state 无法在"新开标签"和"切回标签"之间共享。

### 5.2 与工作台 hook 的关系

`useDatabaseWorkbench` 目前既管连接（`openDatabaseConnection` / tunnel / `runDatabaseQuery`）又管 tab 列表。改造：

- **连接与执行**留在 hook：`connectTab(tabId, connection)`、`runQuery(tabId, sql)`、`cancelQuery`、`closeConnection(tabId)`；
- **tab 列表/草稿/标题**移到 `databaseTabStore`；
- `useDatabaseWorkbench` 的入参改为 store 的 tabs（`DatabaseWorkbenchTab[]`），输出渲染所需的 `activeTab`、`result`、`running`。

这样 surface 卸载（App 退到后台/窗口最小化）也不会丢草稿，重开标签时按 `connectionId` 重连。

### 5.3 Surface 组件

新增 `components/databases/DatabaseWorkbenchSurface.tsx`：

```tsx
export const DatabaseWorkbenchSurface: React.FC<{
  activeTabId: string;                 // 已剥离前缀
  connections: DatabaseConnection[];
  onUpdateConnections?: ...;           // 保存查询
  tunnelDeps?: DatabaseTunnelDeps;
}> = ...
```

结构（复用现有工作台内部布局，去掉 `Dialog` 外壳）：

```
┌ 标签级头部：连接名 · 状态点 · [Schema 侧栏开关] · 工具条（运行/取消/格式化/导出/事务）
├ 左侧：schema 树（可拖宽）
├ 中间：Monaco SQL 编辑器（可拖高）
└ 底部：结果网格 + 分页 + 状态栏
```

Surface 自身不渲染标签栏（标签栏永远是 App 的 `TopTabs`）。

挂载（`application/app/AppMounts.tsx` 同款）：

```tsx
const isActive = useIsDatabaseActive();     // activeTabId 以 database: 开头
const containerStyle = isActive ? {} : { visibility: 'hidden', pointerEvents: 'none', position: 'absolute', zIndex: -1 };
```

延迟加载：`LazyLoadBoundary name="Database workbench"` + `lazy(() => import(...))`，与 `SftpViewMount` 一致。

### 5.4 顶部标签渲染

`components/top-tabs/TopTabItems.tsx` 新增 `DatabaseTopTab`（抄 `EditorTopTab`）：

- 图标：`Database`（lucide）
- 标题：`tab.title`（超长截断；双击重命名，复用现有内联重命名交互）
- 状态：`connecting` 旋转图标、`error` 红点、`transactionOpen` 显示小圆点
- 关闭：X/中键 → `databaseTabStore.close(id)`（走统一 close 路径，见 5.6）

`TopTabs.tsx` 在 `EditorTopTab` / `PluginViewTopTab` 旁新增分支，并在 props 类型里加 `databaseTabs`。

`AppSideEffects.tsx:1049` 的 `additionalWorkTabIds` 追加：

```ts
const databaseTabTopIds = useMemo(() => databaseTabs.map((tab) => toDatabaseTabId(tab.id)), [databaseTabs]);
const additionalWorkTabIds = useMemo(
  () => [...editorTabTopIds, ...pluginViewTabIds, ...databaseTabTopIds],
  [editorTabTopIds, pluginViewTabIds, databaseTabTopIds],
);
```

编号快捷键 `buildNumberShortcutTabTargets`（`application/app/tabShortcutTargets.ts`）已按 `orderedTabs` 计算，新增前缀自动生效，无需改动。

### 5.5 打开入口

| 入口 | 现状 | 改造 |
| --- | --- | --- |
| Vault → 数据库卡片"打开" | `setWorkbenchConnection` 打开 Dialog | `databaseTabStore.open(conn)` + `setActiveTabId(toDatabaseTabId(...))` |
| 双击卡片 | 同上 | 同上 |
| 右键菜单 | 无 | 新增"在新标签打开 / 复制连接 / 编辑 / 删除" |
| QuickSwitcher | 只有 host/tab/action/shell/plugin-view | 新增 `database` 类别：输入连接名 → 打开标签 |
| 命令面板/快捷键 | 无 | 可选：`Cmd+Shift+D` 打开数据库分区（Stub 留空） |

`VaultViewLayout` 里删除 `workbenchConnection` state 和 `<SqlWorkbench>`，`DatabasesManager` 的 `onOpenConnection` 改为回调到 App 层（`VaultView` props 已能透传）。

### 5.6 关闭语义

统一走 `closeTabsBatchImpl`（`AppHandlers.ts:776`）：

1. 分类时新增分支：`isDatabaseTabId(id)` → `databaseTabStore.getTab(...)`；
2. 事务未提交（`transactionOpen === true`）→ `ConfirmDialog`（"该标签有未提交事务，关闭将回滚"）；
3. 关闭动作：`closeDatabaseSession(tabId)`（断开 + 清理 tunnel）→ `databaseTabStore.close(tabId)`；
4. 焦点回退沿用 `resolveBatchTabCloseFocus`，把 `databaseTabTopIds` 计入 `orderedTabIds`。

`executeHotkeyActionImpl` 的 `closeTab` 分支加一条 `isDatabaseTabId` 特判；`nextTab/prevTab/switchToTab` 走 `orderedTabs` 无需改。

### 5.7 连接生命周期

- **打开标签**：`ensureDatabaseTunnel`（如有 SSH 跳板）→ `openDatabaseConnection` → `status: 'ready'`；
- **切走**：不断开（用户可能马上切回）；可选"空闲 N 分钟自动断开"设置项（默认关）；
- **关闭标签**：断开 + `closeDatabaseTunnel`；
- **连接丢失**（查询返回 `connection-closed`）：`status: 'error'` + 头部"重连"按钮（复用现有 `reconnect`）；
- **应用退出**：`disposeDatabaseConnections()`（已有 `useDatabaseWorkbench` 卸载清理逻辑迁移到 store 的 `closeAll`）。

### 5.8 持久化与恢复

存储键（`infrastructure/config/storageKeys.ts`）：

```ts
STORAGE_KEY_DATABASE_TABS = 'netcatty_database_tabs_v1';
```

落盘内容（**只存元数据与草稿**，不存结果/密码）：

```ts
{ tabs: [{ id, connectionId, title, sql, order }], activeTabId?: string }
```

读取时机：`useVaultState` 或独立 `useDatabaseTabsPersistence` 在启动时水合；**不自动连接**，首次激活标签时再连。恢复失败（连接已删除）时丢弃该标签并提示一次。

### 5.9 i18n

新增键（5 语言）：

- `databases.tab.title`（默认标题"数据库"）
- `databases.tab.close`、`databases.tab.rename`、`databases.tab.renamePlaceholder`
- `databases.tab.closeWithTransaction`（确认文案 title/description/confirm）
- `databases.tab.reconnect`、`databases.tab.disconnected`
- `databases.quickSwitcher.database`

`application/i18n/locales/databaseLocales.test.ts` 的 key 表同步。

### 5.10 与 Vault 分区的关系

Vault 的"数据库"分区继续作为**连接管理**（列表/新建/编辑/删除/驱动管理），只是"打开"从弹窗变成开标签。两处共用 `dbConnections` 状态，互不重复。

---

## 6. 迁移与兼容

1. `SqlWorkbench.tsx` 拆成两层：
   - `DatabaseWorkbenchSurface.tsx`（新，铺满，接 store）
   - 内部 pane 组件（编辑器 + 结果 + schema），由 surface 渲染；
   现有 `SqlWorkbench` 的 Dialog 外壳删除。
2. `useDatabaseWorkbench` 拆分：连接/执行留在 hook，tab 列表移交 store（见 5.2）。
3. **不改动**任何持久化 schema（`netcatty_db_connections_v1`、`netcatty_jdbc_drivers_v1`），云同步逻辑零改动。
4. 旧的 `workbenchConnection` state、`Dialog` 相关 i18n 键（如 `databases.workbench.resize`）保留一版，下个版本清理。

---

## 7. 边界与风险

| 风险 | 说明 | 处理 |
| --- | --- | --- |
| 连接数膨胀 | 每个标签一个会话，开十个标签就是十条连接 | 头部显示连接状态；提供"关闭其它数据库标签"；可选空闲断开 |
| surface 常驻内存 | 结果集最多 1 万行 × 多标签 | 非激活标签可只保留 SQL 草稿，丢弃 `result`（切回时提示重新执行）；或统一 5 个标签保留结果 |
| 事务悬挂 | 标签隐藏但事务未提交 | 关闭确认（5.6）+ 头部常驻事务徽标 |
| 与终端标签冲突 | 前缀解析顺序 | `isDatabaseTabId` 判断放在 session/workspace 查找之前 |
| QuickSwitcher 性能 | 标签多了以后 | 复用现有虚拟列表 |
| 多窗口（peer window） | 数据库标签只在主窗口 | 与 plugin view 一致：非主窗口不注册 |
| Tab 恢复与云同步 | 标签是本地 UI 状态 | 不参与 `SyncPayload`，仅本地 localStorage |

---

## 8. 测试计划

**单元测试**

- `databaseTabStore.test.ts`：open/close/update、同连接多标签、重复打开策略、关闭清理、恢复水合、非法 connectionId 丢弃；
- `activeTab` 前缀 helper：`toDatabaseTabId`/`isDatabaseTabId`/`fromDatabaseTabId`；
- `resolveBatchTabCloseFocus` 覆盖含 database 前缀的邻居回退；
- `databaseLocales.test.ts`：新键 5 语言非空 + 占位符。

**组件测试（renderToStaticMarkup / @testing-library）**

- `DatabaseTopTab`：标题截断、状态点、关闭回调；
- `DatabaseWorkbenchSurface`：非激活时 `visibility: hidden` 且不卸载；激活时渲染编辑器；
- `TopTabs`：database 标签参与排序与编号。

**集成/手工**

1. Vault 打开连接 → 顶部出现标签 → 主区域铺满，无遮罩；
2. 切到终端再切回：SQL、结果、分页页码保留；
3. `Cmd+W` 关闭 → 连接断开（主进程日志/`process` 列表无残留 java）；
4. 事务中关闭 → 弹确认；
5. 重启应用 → 标签与草稿恢复，不自动连接；
6. 连接被删除 → 启动时丢弃标签并提示。

---

## 9. 分阶段实施

| 阶段 | 内容 | 人日 |
| --- | --- | --- |
| P1 | `databaseTabStore` + 前缀 helper + 单测；surface 骨架（复用现有 workbench 内容，去掉 Dialog）；`AppMounts` 显隐 | 1.5 |
| P2 | TopTabs `DatabaseTopTab`、`additionalWorkTabIds` 接入、打开入口改造（Vault/双击/右键） | 1 |
| P3 | 关闭路径（批次/`Cmd+W`/事务确认）、连接生命周期、焦点回退、快捷键编号验证 | 1 |
| P4 | 持久化与恢复、QuickSwitcher、重命名、i18n 收尾、回归测试 | 1 |
| 可选 P5 | workspace pane（方案 B）扩展，另立设计 | 12–18 |

我连续实现 P1–P4 预计 1 天内可交付测试包。

---

## 10. 变更文件清单（预计）

**新增**

- `application/state/databaseTabStore.ts` / `.test.ts`
- `components/databases/DatabaseWorkbenchSurface.tsx`
- `components/top-tabs/DatabaseTopTab.tsx`（或并入 `TopTabItems.tsx`）
- `application/app/useDatabaseTabPersistence.ts`

**修改**

- `application/state/activeTabStore.ts`（前缀 helper，或放 store 内）
- `application/app/AppSideEffects.tsx`（`additionalWorkTabIds`）
- `application/app/AppHandlers.ts`（`closeTabsBatchImpl`、`closeTab` 分支）
- `application/app/AppView.tsx` / `AppMounts.tsx`（surface 挂载）
- `components/TopTabs.tsx`、`components/top-tabs/TopTabItems.tsx`
- `components/vault/VaultViewLayout.tsx`、`components/databases/DatabasesManager.tsx`
- `components/databases/SqlWorkbench.tsx`（拆壳）
- `application/state/useDatabaseWorkbench.ts`（状态来源）
- `components/QuickSwitcher.tsx`
- `infrastructure/config/storageKeys.ts`
- i18n：`application/i18n/locales/*/database.ts`（5 语言）

---

## 11. 待确认问题

1. **同连接多标签**：允许（像终端）还是复用已有标签？倾向允许。
2. **结果集保留策略**：所有标签都保留结果，还是非激活标签丢弃结果只留 SQL？
3. **空闲断开**：是否需要"N 分钟无操作自动断开"设置？
4. **分屏**：本期确认不做 workspace pane（方案 B）吗？
5. **恢复**：重启后是否自动恢复数据库标签（不自动连接）？
