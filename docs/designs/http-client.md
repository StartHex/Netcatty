# HTTP 客户端（Curl Tool 内置标签页）

Status: 设计稿，2026-10-26。尚未实现。

目标：在 NetCatty 里新增一类“HTTP 请求”工作区，交互参照常见的 curl 工具（方法下拉、Params / Body /
Headers / Cookies / Auth 分栏、请求体与响应体上下分区），侧边栏新增一个与「数据库」并列的类别，
请求以**内置顶层标签页**打开（与数据库工作台同一套机制），而不是弹窗。

## 1. 范围

### v1 必做

- 侧边栏新类别「HTTP」（位置在「数据库」之后），保存的请求列表 + 文件夹 + 搜索。
- 内置标签页：一个请求一个标签，可与数据库标签、终端标签并存、拖拽排序、右键批量关闭、草稿持久化。
- 请求编辑器：方法（GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS）、URL 拆分输入、Params、Headers、Cookies、Auth、Body。
- URL 拆分输入（本次需求重点，见 §3）：完整 URL ↔ `host` / `port` / 其余部分 双向同步。
- 响应面板：状态码、耗时、大小、Headers、Body（JSON 美化 / 原文）、复制、保存到文件。
- 请求历史（最近 200 条，本地）。
- 取消请求、超时、重定向跟随开关、TLS 校验开关。
- 保存的请求进加密 vault，并接入云同步（凭据字段按仓库既有规则剥离，见 §7）。
- 主进程发请求（绕开渲染层 CORS/混合内容限制），协议仅允许 `http` / `https`。

### v2 候选

- `curl` 文本导入（粘贴命令 → 还原请求）与「复制为 curl」。
- Cookie jar（自动收/发 Set-Cookie）。
- 环境变量与 `{{baseUrl}}` 变量替换。
- 经 SSH 主机发出请求（复用现有主机与端口转发，见 §8）。
- 多部分表单（multipart）与文件上传。
- 集合级批量运行（类似 run collection）与断言。

### 明确不做

- 不做浏览器（已有 host-routed browser 设计 `host-routed-browser.md`，两者定位不同：那边是浏览网页，这边是构造/调试 API 请求）。
- 不做 GraphQL/WebSocket/gRPC 专用客户端（v1 用 raw body 即可发 GraphQL）。

## 2. 数据模型

`domain/models/http.ts`：

```ts
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface HttpKeyValue {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

export type HttpBodyKind = 'none' | 'json' | 'text' | 'xml' | 'form' | 'graphql';

export type HttpAuthKind = 'none' | 'basic' | 'bearer' | 'apiKey';

export interface HttpAuth {
  kind: HttpAuthKind;
  username?: string;
  password?: string;
  token?: string;
  apiKeyName?: string;
  apiKeyValue?: string;
  apiKeyIn?: 'header' | 'query';
}

export interface HttpRequestDef {
  id: string;
  name: string;
  folder?: string;
  method: HttpMethod;
  url: string;              // 权威来源
  headers: HttpKeyValue[];
  cookies: HttpKeyValue[];
  params: HttpKeyValue[];   // 派生自 url 的 query，改这里会回写 url
  body: { kind: HttpBodyKind; text: string };
  auth: HttpAuth;
  options: {
    followRedirects: boolean;
    maxRedirects: number;   // 默认 10
    verifyTls: boolean;     // 默认 true
    timeoutMs: number;      // 默认 30000，上限 120000
    httpVersion?: 'auto' | 'http1' | 'http2';
  };
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export interface HttpResponseMeta {
  status: number;
  statusText: string;
  httpVersion?: string;
  headers: Array<{ key: string; value: string }>;
  durationMs: number;
  sizeBytes: number;
  truncated: boolean;
  redirects: Array<{ status: number; location: string }>;
  contentType?: string;
  bodyKind: 'text' | 'json' | 'html' | 'xml' | 'binary' | 'empty';
  bodyText?: string;        // 文本类
  bodyBase64?: string;      // 二进制、或超过 2 MB 的文本不内联
}
```

- `url` 是权威来源；`params` 是 query 的可视化视图（§3.4）。
- 发送时的有效请求由纯函数 `buildHttpWireRequest(def)` 生成（合并 auth/params/headers/cookies，去重规则：显式 header
  优先于 auth 生成的 header，`Content-Type` 由 body.kind 决定，用户手写则覆盖）。

## 3. URL 拆分输入（核心交互）

### 3.1 三个输入 + 一个文本框

界面一行四个控件：

| 控件 | 含义 | 为空时 |
| --- | --- | --- |
| `scheme` 下拉 | `http` / `https` | 由上一次或默认 `https` |
| `host` | 主机名或 IP（IPv6 不加括号） | 必填，空则 URL 无效 |
| `port` | 1–65535，留空表示跟随协议默认 | 留空 → `http:80` / `https:443` |
| `path + query` | 从 `/` 开始，含 query | 空 → `/` |

上方（或行的左侧）保留**完整 URL 文本框**，可整体粘贴/编辑。两个方向都实时同步：

- 改完整 URL → 解析并回填四段；解析失败时保留文本、标红，且**不回填**（避免把用户正在输入的内容改坏）。
- 改任一段 → 立即重新拼装完整 URL 文本。

### 3.2 解析与拼装算法（`domain/http/urlParts.ts`）

```ts
export interface HttpUrlParts {
  scheme: 'http' | 'https';
  host: string;            // 已去 IPv6 方括号
  port: number | null;     // null = 默认端口
  path: string;            // 以 '/' 开头，未含 query
  query: string;           // 不含 '?'
}

export function parseHttpUrl(input: string): { ok: true; parts: HttpUrlParts } | { ok: false; reason: string };
export function composeHttpUrl(parts: HttpUrlParts): string;
export function effectivePort(parts: HttpUrlParts): number;
```

规则：

1. 缺协议时按 `https` 补全（粘贴 `api.example.com/users` 也能用）；显式写了 `http://` 则保持。
2. 默认端口不显示：`443` 配 `https`、`80` 配 `http` → `port` 存 `null`，拼装时省略；用户填了 443 但协议是 http 则保留为显式端口。
3. 切换协议：`port === null` 时端口随新协议默认；显式端口保持不变。
4. IPv6：输入 `::1` 或 `[::1]` 都能解析，内部存 `::1`，拼装时补 `[ ]`；含 `:` 的 host 一定是 IPv6。
5. URL 里带 userinfo（`user:pass@host`）→ 剥离并迁移到 Auth（basic），URL 文本不含凭据。
6. `path` 至少为 `/`；连续多余斜杠保留原样（不擅自规范化，避免破坏对方路由）。
7. 端口非法（非数字、越界、`0`）→ 解析失败，文本标红，不回填；输入过程中允许暂时为空。
8. 保留原样的 query 顺序与编码，不做 `+`/`%20` 归一化。

单元测试必须覆盖：round-trip 幂等（`compose(parse(x)) === x` 对规范化后的 x）、默认端口、IPv6、userinfo、缺协议、非法端口、
空 path、含 `?`/`#` 的 path（`#` 视为 fragment，v1 不发送，提示丢弃）。

### 3.3 派生与防抖

- 文本框 → 拆分：`onChange` 即时解析；连续输入用 120ms 防抖避免光标跳动。
- 拆分 → 文本框：无防抖，逐键盘更新。
- 焦点保护：正在编辑的字段不被另一侧覆盖（记录 `lastEditedSide`）。

### 3.4 Params 与 URL 的关系

- Params 表读写同一份 query：进入标签时由 `query` 解析出键值行（含重复键，保序）；编辑行 → 重写 `query` → 更新 URL 文本；
  直接改 URL 的 query → 重新解析行。
- 关闭/禁用的行不删除，只是不参与拼装（`enabled: false` 的行保留在 `params` 中，但不写回 `url`，与主流工具一致：
  这里存两份，`url` 只反映启用项）。

## 4. 主进程请求桥（`electron/bridges/httpBridge.cjs`）

IPC（沿用 `netcatty:<domain>:<action>` 命名）：

| 通道 | 载荷 | 返回 |
| --- | --- | --- |
| `netcatty:http:request` | `HttpWireRequest` | `{ ok: true, response } \| { ok: false, error }` |
| `netcatty:http:cancel` | `{ id }` | `{ ok: true }` |
| `netcatty:http:save-response` | `{ id, suggestedName }` | `{ ok: true, filePath } \| { ok: true, canceled: true }` |

`HttpWireRequest` 由渲染层纯函数生成：`{ id, method, url, headers, bodyText?, bodyBase64?, timeoutMs, followRedirects, maxRedirects, verifyTls }`。

实现要点：

1. 用 Electron `net.fetch`（Chromium 网络栈，跟随系统代理）为主；不可用时回落 Node `undici`。两者都要 `AbortController`。
2. **不自动跟随重定向**：自行循环（`redirect: 'manual'`），便于记录 3xx 链并遵守 `maxRedirects`；跨协议（https→http）允许但记录警告。
3. 大小上限：默认 `MAX_BODY_BYTES = 8 MB`；超出读取时截断并置 `truncated: true`，同时给 `sizeBytes`。
4. 二进制判定：`content-type` 二进制族 或 解码失败 → `bodyBase64`；文本类按 `utf-8` 解码（后续可选 charset 识别）。
5. 计时：`durationMs` 为首字节到读完的墙钟时间；后续可加 timeline（DNS/连接/TLS/TTFB）。
6. 取消：每个请求一个 `AbortController`，`cancel` 会 abort 并让 `request` 返回 `{ ok:false, error:{ code:'canceled' } }`。
7. 错误归一：`{ code, message, detail? }`，错误码含 `timeout` / `canceled` / `dns` / `tls` / `connection` / `protocol` / `too-large`。
8. 安全：仅接受 `http:`/`https:`；拒绝 `file:`、`data:`、`chrome:` 等；`verifyTls: false` 时对该请求禁用证书校验
   （实现：`net.fetch` + 会话级 `setCertificateVerifyProc` 白名单，或在 fallback 路径用 `tls.connect({ rejectUnauthorized:false })`）。
9. 不做 cookie 自动存储（v1），`Cookie` 头由 Cookies 表生成。

## 5. 渲染层结构与标签接入

沿用数据库工作台已经验证过的「store + 顶层标签 + 常驻 surface」方案：

| 层 | 文件 | 说明 |
| --- | --- | --- |
| 标签 store | `application/state/httpTabStore.ts` | 前缀 `http:`、`HttpTabSummary`、`requestOpen/requestClose/activate/sync`、草稿落 `netcatty_http_tabs_v1` |
| 工作状态 | `application/state/useHttpClient.ts` | 每个标签的请求定义、响应、发送/取消、历史记录 |
| 顶层标签 | `components/top-tabs/TopTabItems.tsx` 的 `HttpTopTab` + `components/TopTabs.tsx` 分支 | 图标 Globe/Waypoints，状态点（发送中/失败） |
| 挂载 | `application/app/AppMounts.tsx` 的 `HttpClientMount` + `hosts/mountsDomain.ts` | `visibility:hidden` 保状态，`z-20` |
| 工作区 | `components/http/HttpClientSurface.tsx` | 每个标签一份，铺满主区域 |
| 侧边栏 | `components/http/HttpCollections.tsx` + `components/vault/VaultViewLayout.tsx` 新导航项 | `VaultSection` 增加 `'http'` |
| 快捷键/批量关闭 | `application/app/AppHandlers.ts` | 与 `isDatabaseTabId` 同构，增加 `isHttpTabId` |

服务适配：`infrastructure/services/httpClientService.ts`（只做 IPC 包装 + 错误归一，组件不得直接访问 `infrastructure`）。

## 6. 界面细节

### 6.1 侧边栏（HTTP 类别）

- 顶部：搜索框、`+ 新建请求`。
- 列表：文件夹可折叠；请求项显示方法徽标（GET 绿、POST 橙、PUT 蓝、PATCH 紫、DELETE 红、HEAD/OPTIONS 灰）+ 名称 + host:port。
- 右键：重命名 / 复制 / 移动到文件夹 / 删除 / 在新标签打开。
- 底部：`导入 curl…`（v2）。

### 6.2 请求编辑器

- 顶部行：方法下拉 → URL 文本框 → 「发送」按钮（`⌘/Ctrl+Enter`），右侧：保存、另存为、复制为 curl（v2）。
- URL 行下方：`scheme / host / port / path` 四段输入（§3）。
- 分栏：Params · Body · Headers · Cookies · Auth · Options。
- 状态行：显示最终 URL（含 query 合并后）、超时、跟随重定向开关、TLS 校验开关、HTTP 版本。

### 6.3 响应面板

- 上边：状态码 pill（2xx 绿 / 3xx 蓝 / 4xx 橙 / 5xx 红）、`durationMs`、`sizeBytes`、复制按钮、保存到文件。
- 分栏：Body · Headers · Cookies · Redirects。
- Body：`Pretty / Raw / Hex` 三态；JSON 尝试解析成可折叠树（懒展开），JSON 失败自动回 Raw 并提示。
- 二进制：显示类型与大小，提供「保存到文件」而非内联渲染。
- 大响应：超过 2 MB 文本不内联渲染，提示另存。

### 6.4 响应区可调高度

请求编辑器与响应面板之间放一条可拖拽分隔条（记忆到标签），与数据库工作台的 schema 分隔条同款实现。

## 7. 持久化与同步

| 数据 | 位置 | 加密 | 云同步 |
| --- | --- | --- | --- |
| 保存的请求（headers / cookies / body / auth） | vault：`netcatty_http_requests_v1` | 敏感字段走 `enc:v1`（复用 `secureFieldAdapter`：`auth.password` / `auth.token` / `auth.apiKeyValue`，以及 `authorization`、`cookie`、`x-api-key` 一类 header 值） | **参与**，但 `enc:v1` 字段在载荷里被剥离，规则与 hosts 的 password、数据库连接的 password 一致（参考 `domain/credentials.ts:240` 对 `dbConnections` 的处理） |
| 打开的标签与草稿 | `netcatty_http_tabs_v1`（localStorage） | 否（只存 url / method / 名称，不存 header 与 auth） | 否 |
| 请求历史 | `netcatty_http_history_v1`（localStorage） | 否；仅 method / url / status / 耗时，不存 header 与 body | 否 |

同步接入点（与 `dbConnections` 完全同构，按顺序接线）：

1. `domain/sync.ts`：`SyncPayload` 增加 `httpRequests`，并加入两组 entity key 列表（用于冲突统计与标签）。
2. `domain/syncMerge.ts`：`OPTIONAL_ENTITY_KEYS` + `mergeEntityArrays` + `entityResults`。
3. `domain/credentials.ts`：注册「剥离 `enc:v1` 字段」的 sanitizer（写进 `sanitizeHttpRequestForSync`）。
4. `domain/convergentSync/payload.ts`：`CONVERGENT_ENTITY_COLLECTIONS` + `typedCollection`。
5. `application/syncPayload.ts`：`SyncableVaultData` 字段、两个 builder、hash 依赖、`vaultImport` 回填。
6. `application/state/useAutoSync.ts`：config 字段 / 快照 / hash 依赖。
7. `components/cloud-sync/CloudSyncControls.tsx`：`httpRequests` → `cloudSync.conflict.entity.httpRequests`（5 语言）。

结论按用户选择：**请求定义随云同步、凭据字段留在本机**。若之后希望 token 也跨设备，需要单独设计（那会把
本机密钥暴露给同步载荷，与 SSH 密码现有策略冲突）。

## 8. 与既有能力的衔接

- **经 SSH 主机请求（v2）**：Netcatty 已有 host-routed browser，说明主机路由已有基础设施；HTTP 客户端可以先做直连，
  再接「经主机」：local 端口转发把远端 `host:port` 映射到本地，先对 `127.0.0.1:port` 建 TLS 并覆写 `SNI`/`Host`，
  或者复用 browser 的代理路径。v1 明确不做，避免半成品。
- **AI 助手（可选 v2）**：选中响应可「让 AI 解释这个报错」，复用 `useSqlAssistant` 的同款一次性调用模式。
- **端口转发/已知主机**：不依赖。

## 9. 测试计划

- `domain/http/urlParts.test.ts`：§3.2 全部规则 + round-trip 幂等（目标 20+ 用例）。
- `domain/http/curlImport.test.ts`（v2）：多行 `curl`、单双引号、`-H`、`-d`、`--data-raw`、`-X`、URL 位置。
- `domain/http/wireRequest.test.ts`：auth 与 header 合并优先级、form 编码、query 合并、Content-Length/Type 推导。
- `electron/bridges/httpBridge.test.cjs`：本地 `node:http` 起服务覆盖 200/204/302（含 3 跳与超过上限）、gzip、超时、取消、
  8 MB 截断、二进制、非法协议拒绝，目标 12+ 用例。
- `application/state/httpTabStore.test.ts`：前缀 helper、open/close 请求、草稿过滤。
- UI 组件测试：方法徽标、URL 拆解三输入双向同步、JSON 美化开关。

## 10. 分阶段与工期

| 阶段 | 内容 | 估时 |
| --- | --- | --- |
| P1 | 模型 + URL 拆解 + 主进程桥 + 标签接入 + 侧边栏 + 请求编辑器（方法/URL/Params/Headers/Body/Auth）+ 响应面板 + 历史 + vault/云同步接线 | 3–3.5 天 |
| P2 | 集合文件夹、curl 导入/导出、Cookie jar、保存响应到文件、多部分表单 | 1.5–2 天 |
| P3 | 经 SSH 主机请求、环境变量、集合批量运行、AI 解释响应 | 2–3 天 |

P1 完成即可日常替代 curl 工具。

## 11. 风险与取舍

1. **TLS 校验开关**：Chromium 的 `setCertificateVerifyProc` 是会话级，容易误伤其它窗口。P1 若走 `net.fetch`，需先做
   请求级白名单（按 host 匹配 + 用后即撤）；实现不稳则 P1 先隐藏该开关，放 P3。
2. **HTTP/2**：`net.fetch` 自动协商，无法强制；`httpVersion` 选项 P1 仅展示实际版本，不强制。
3. **编码**：非 UTF-8 响应（GBK 等）P1 只按 UTF-8 解码并在界面提示，P2 增加 charset 探测。
4. **`params` 双份表示**：`url` 与 `params` 可能短暂不一致；约定 `url` 权威，UI 以 `url` 重算 params，避免死循环。
5. **与浏览器工具的边界**：本工具不渲染 HTML（只做源码/JSON 查看），避免与 host-routed browser 功能重叠。

## 12. 已确认的设计决策（2026-10-26）

1. `curl` 粘贴导入 / 复制为 curl：**放第二阶段**。
2. 经 SSH 主机发出请求：**第一阶段只做直连**，主机路由放后续阶段。
3. 保存的请求：**加密存 vault，并参与云同步**；`enc:v1` 凭据字段在同步载荷中剥离（与 hosts / dbConnections 同规则）。

仍需在实现时确认的小项：
- 响应体上限 8 MB、历史 200 条是否够用。
- TLS 校验开关在 P1 是否可见（取决于 `net.fetch` 的会话级证书钩子能否做到请求级白名单，见 §11 风险 1）。

## 13. 实施记录（P1，2026-10-26）

侧边栏类别与 i18n 前缀统一用 `curl`（不是 `http`），与数据库工作台的分区/标签结构一致。

### 13.1 已落地模块

| 层 | 文件 | 说明 |
| --- | --- | --- |
| 领域 | `domain/http/urlParts.ts` | 手写解析/拼接：`scheme/host/port/path/query` 五段各自可编辑；改协议时只有端口是旧协议默认值才回落 `null`；行列化 query 用 `splitQueryString`/`joinQueryString`。 |
| 领域 | `domain/http/httpWire.ts` | 组装请求：cookies 合并成 `Cookie`、basic/bearer/apiKey（header 或 query）、GET/HEAD 丢弃 body 并给 `body-dropped-for-method` 警告、URL 内 userinfo 剥离。 |
| 领域 | `domain/http/history.ts` | 历史 200 条，同 method+url 去重提前。 |
| 模型 | `domain/models/http.ts` | `CurlRequest`/`CurlResponse`/`CurlWireRequest`/`sanitizeCurlRequest(s)`/`redactCurlRequestForSync`/`isSensitiveHeaderName`。 |
| 主进程 | `electron/bridges/httpBridge.cjs` | node `http`/`https`（未用 `net.fetch`）：手工重定向 301/302/303/307/308、gzip/deflate/br/zstd、8 MB 上限、超时/取消、header 注入防护、错误码归一。IPC：`netcatty:http:request`、`netcatty:http:cancel`。 |
| 服务 | `infrastructure/services/httpClientService.ts` | 渲染层只依赖这一层调 IPC。 |
| 状态 | `application/state/curlTabStore.ts` | `curl:` 前缀、摘要同步、草稿恢复、open/close 请求队列。 |
| 状态 | `application/state/useHttpClient.ts` | 标签草稿、发送/取消/保存、响应与警告、历史记录、从 store 消费打开请求。 |
| UI | `components/curl/CurlCollections.tsx` | 侧边栏列表（搜索、打开、删除）。 |
| UI | `components/curl/CurlClientSurface.tsx` | 顶部方法 + 发送/取消/保存/名称/历史；URL 文本框与 scheme/host/port/path 四段双向同步；请求区分栏 6 页；响应区 Body/Raw/Headers。 |
| 标签 | `components/top-tabs/TopTabItems.tsx` `CurlTopTab` | 顶部工作标签，方法徽标 + 状态点 + 右键批量关闭 + 拖拽。 |

附加增强（同批次）：请求体 JSON 一键格式化/压缩 + 树形预览；响应体 JSON 树形折叠（加减号）、文本/树形切换、复制；响应体编码选择（auto/UTF-8/GB18030/Big5/Shift_JIS/ISO-8859-1/UTF-16LE，按 content-type charset 自动推断）；历史条目保存请求与响应快照（响应体上限 64 KB，敏感 header 值在写入明文 localStorage 前替换为 `***`），详情弹窗可查看请求/响应并复制响应、回填编辑器。

### 13.2 与设计的偏差

- 未使用 `net.fetch`，直接用 node `http`/`https`：需要请求级 TLS 开关与取消，`net.fetch` 走 Electron 会话证书钩子无法按请求粒度控制。
- Params 页不保留"禁用"行语义：`url` 是唯一事实来源，改 URL 会重建参数行；避免 URL 与行表格双向同步出现分叉。
- 阶段一的 URL 校验是"软校验"：非法 host/port 只标红，不阻止输入，发送时才报错。
- 桥接对 4 MB 以内的响应额外返回 `bodyBase64`：渲染层换编码时需要原始字节，只靠 `bodyText`（已按 UTF-8 解码）会丢信息。

### 13.3 未完成（后续阶段）

- curl 粘贴导入 / 复制为 curl、`-H`/`-d`/`--data-raw` 解析。
- 经 SSH 主机的隧道请求。
- multipart/form-data 文件上传、响应体保存到文件。
- 环境变量（`{{baseUrl}}` 等）与请求链。

### 13.4 本机构建备注

打包必须带项目配置文件，否则 `asarUnpack`、压缩和产物命名全部失效（asar 会膨胀到 700 MB 以上）：

```bash
npm run build
npx electron-builder --config electron-builder.config.cjs --mac dmg --arm64 \
  -c.directories.output=/tmp/nce-out -c.mac.identity=null
```

本机 ad-hoc 签名需要先 `xattr -cr` 再 `codesign --force --deep --sign -`，否则 dmg 里的包会因为资源封签缺失而打不开。
