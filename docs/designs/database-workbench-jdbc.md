# 数据库工作台与 JDBC 支持设计

> 状态：设计稿（未实施）
> 目标分支：`feat/database-workbench`（fork 专属，独立于 #3926）
> 关联需求：数据库连接管理（参考 navop 的产品形态）+ JDBC 模式（自备 jar、可连内存库）

---

## 0. 结论摘要

1. **navop 的代码不能搬。** 它采用 `Apache-2.0 + Navop 补充条款` 的双重许可：补充条款明确
   "不得基于本软件的全部或部分代码创建竞争性产品或服务"，而 NetCatty 与 navop 的产品定位
   高度重叠（SSH/SFTP/终端/数据库/监控/AI 一体工作台），属于典型竞品。此外该补充条款本身
   与 GPL-3.0（NetCatty 的许可证）不兼容，即使忽略竞品条款也不能并入本仓库。
2. **可用的替代参考**见第 2 节：代码可搬的是 GPL-3.0 的 DbGate / Beekeeper Studio（同许可、
   保留声明即可）；设计可参考 Apache-2.0 的 DBeaver（JDBC 驱动管理是业界最完整的开源实现）。
   但 navop 是 Rust/Tauri，NetCatty 是 TypeScript/Electron/React，二者之间不存在"搬迁"，
   最多是产品形态与交互的借鉴。
3. **JDBC 不建议用 `node-jdbc`/`node-java`**（JNI 原生模块，Electron ABI 一变就要重编）。
   建议自带一个极小的 Java sidecar（约 300 行，MIT），通过 stdin/stdout 上的 JSON-RPC 执行
   JDBC，classpath 由用户选择的驱动 jar 组成。这样任意 JDBC 驱动（含 H2/Derby 内存库、
   达梦/人大金仓等国产库）都能接入，且不依赖 native 编译。
4. **内存库**的关键不是 URL，而是**会话生命周期**：`jdbc:h2:mem:` 在最后一个连接关闭时销毁。
   sidecar 必须以"每个连接一个常驻会话"的方式持有 Connection，并提供 `initSql` 重放，才能在
   多次查询之间保住表结构。
5. 建议分四期：P1 原生驱动（Postgres/MySQL/SQLite）连接与查询；P2 JDBC sidecar + 驱动管理 +
   内存库；P3 schema 浏览、SSH 隧道、历史与导出；P4 AI 辅助。
6. **JDBC 是"万能扩展点"，与 DBeaver 同构**（见 6.7）：驱动 = 一条预设 + 用户自备 jar，
   新增数据库类型无需发版。因此不需要为 Oracle/达梦/金仓等逐个写适配层。
7. **三平台（Windows / macOS / Linux）等价支持**（见 6.8）：一个纯 Java sidecar 通吃三平台，
   分平台差异集中在 Java 探测、classpath 分隔符、进程回收与编码，全部封装在 `jdbcBridge.cjs`；
   P2 的验收包含三平台打包与中文路径烟测。

---

## 1. 需求拆解

| 编号 | 需求 | 验收标准 |
| --- | --- | --- |
| D1 | 数据库连接管理 | 可在侧栏新增/编辑/删除/分组数据库连接，支持常见关系库与 Mongo/Redis；保存后重启仍在 |
| D2 | 连接测试与凭据 | 表单内"测试连接"给出耗时与服务器版本；密码加密存储、默认不随云同步明文外泄 |
| D3 | SQL 工作台 | 多标签页编辑器、执行选中/全部、结果表格、影响行数、耗时、错误信息定位到行 |
| D4 | JDBC 模式 | 可登记多个 JDBC 驱动（jar 路径 + 驱动类名）；连接可填任意 JDBC URL 与属性 |
| D5 | 内存库 | `jdbc:h2:mem:...`、`jdbc:derby:memory:...` 等可连接；同一连接多次查询表不丢；可配初始化 SQL |
| D6 | 复用 SSH 通道 | 数据库连接可绑定已有 SSH 主机，经本地端口转发访问内网库 |
| D7 | 安全 | 自备 jar 加载前提示风险并记录 sha256；破坏性 SQL 二次确认；只读连接强制只读 |

非目标（本期不做）：数据库建模/ER 图、数据同步/迁移、备份还原、团队协作、云端托管驱动仓库。

---

## 2. 许可证评估：能不能"搬代码"

### 2.1 navop 为什么不行

- 仓库根目录同时存在 `LICENSE-APACHE` 与 `NAVOP_LICENSE`。README 的 License 一节写明：
  "Navop-authored portions are additionally subject to the Navop Supplementary License"。
- `NAVOP_LICENSE` 第四条（四）："您不得基于本软件的全部或部分代码创建竞争性产品或服务"；
  第四条（一）（二）还禁止收费分发与作为商业产品组成部分再分发。
- 结论：**source-available，不是开源**。复制进 NetCatty 属于双重违约（竞品 + 违反 GPL 兼容性）。
  即使只抄数据模型或 SQL 方言表也存在"部分代码"的解释风险，建议完全独立实现，仅借鉴产品思路。

### 2.2 可参考/可复用的项目

| 项目 | 技术栈 | 许可证 | 能否把代码搬进 GPL-3.0 的 NetCatty | 建议用途 |
| --- | --- | --- | --- | --- |
| [DbGate](https://github.com/dbgate/dbgate) | JS/Electron/React | GPL-3.0 | ✅ 可以（同为 GPL-3.0，保留版权与许可声明） | 连接模型、查询标签页、结果表格交互的直接参考；必要时可移植组件 |
| [Beekeeper Studio](https://github.com/beekeeper-studio/beekeeper-studio) | Vue/Electron | GPL-3.0 | ✅ 可以 | 交互与快捷键参考（Vue 组件不能直接用） |
| [DBeaver CE](https://github.com/dbeaver/dbeaver) | Java | Apache-2.0 | ✅ 可以（Apache-2.0 → GPL-3.0 单向兼容） | **JDBC 驱动管理与元数据读取的最佳参考**；可移植思路与错误码映射表 |
| [pgAdmin 4](https://github.com/pgadmin-org/pgadmin4) | Python/JS | PostgreSQL License（宽松） | ✅ 可以 | Postgres 专属元数据 SQL 参考 |
| [HeidiSQL](https://github.com/HeidiSQL/HeidiSQL) | Object Pascal | GPL-2.0-only | ❌ 不可以（GPL-2.0-only 与 GPL-3.0 不兼容） | 仅可阅读 |
| navop | Rust/Tauri | Apache-2.0 + 补充条款（禁竞品） | ❌ 不可以 | 仅可借鉴产品形态 |

> 许可结论只针对"复制代码"。阅读闭源/受限项目的界面与文档、自行实现同等功能，不构成侵权。

### 2.3 依赖选型（全部为 MIT/Apache-2.0，可安全引入）

**内置驱动（无需 Java、无需 jar）**：

| 数据库 | 包 | 许可证 | 说明 |
| --- | --- | --- | --- |
| PostgreSQL | `pg` | MIT | 含连接池、TLS |
| MySQL / MariaDB | `mysql2` | MIT | 支持 caching_sha2_password |
| Oracle | `oracledb` | Apache-2.0 OR UPL-1.0 | **Thin 模式为纯 JS**，不需要 Instant Client、不需要 Java |
| SQLite | Electron 42 内置 `node:sqlite` | Node 内置 | 回退 `better-sqlite3`（MIT，需 electron-rebuild） |
| SQL Server | `tedious` | MIT | P3 |
| MongoDB | `mongodb` | Apache-2.0 | P3 |
| Redis | `ioredis` | MIT | P3 |

**辅助依赖**：

| 用途 | 包 | 许可证 |
| --- | --- | --- |
| SQL 编辑器 | `@codemirror/*` + `@codemirror/lang-sql` | MIT |
| 结果表格 | `@tanstack/react-table` + `@tanstack/react-virtual` | MIT |
| SQL 格式化 | `sql-formatter` | MIT |
| JDBC sidecar | 自研（`resources/jdbc/netcatty-jdbc-bridge.jar`） | MIT（本仓库） |

**不随包分发的驱动**：MySQL Connector/J（GPL-2.0 + FOSS 例外）与 Oracle ojdbc（OTN/UPL 双许可，
分发条款需逐版本确认）都不打包；Oracle 走 `oracledb` Thin 模式解决，MySQL 走 `mysql2`。
达梦/人大金仓/ClickHouse/DuckDB 等商业或无 JS 驱动的库，统一走"用户自备 jar + JDBC"路线，
由用户自行从官方渠道下载，规避分发许可问题。

**内置 vs JDBC 的边界**：内置驱动覆盖 90% 日常场景，零 Java 依赖、启动快、类型映射好；
JDBC 是"任意数据库"的扩展点，需要 Java + 用户自备 jar。两者共用连接模型、查询工作台与结果表格。

---

## 3. 架构总览

```
renderer (React/TS)                         main (Electron/CJS)
┌───────────────────────────┐               ┌──────────────────────────────┐
│ components/databases/*    │  window.      │ electron/bridges/dbBridge.cjs│
│  ├ DatabaseManager        │  electron.db  │  ├ native drivers (pg/mysql2 │
│  ├ DbConnectionDialog     │ ────────────► │  │  /better-sqlite3/...)      │
│  ├ SqlWorkbench           │   IPC         │  ├ jdbcBridge.cjs ── spawn ──┐│
│  └ ResultGrid             │               │  └ ssh tunnel (复用 host)    ││
├───────────────────────────┤               └──────────────────────────────┘│
│ application/state/        │                              │ java -cp ...     │
│  └ useDatabaseState.ts    │                              ▼                  │
├───────────────────────────┤               ┌──────────────────────────────┐ │
│ domain/database/*.ts      │               │ netcatty-jdbc-bridge.jar     │ │
│  (纯逻辑：URL/校验/类型)   │               │ JSON-RPC over stdio          │ │
└───────────────────────────┘               └──────────────────────────────┘ │
```

分层遵守 `AGENTS.md`：纯逻辑进 `domain/`，状态与持久化边界进 `application/state/`，UI 只做展示，
主进程能力放 `electron/bridges/*.cjs`（CJS + 同目录 `*.test.cjs`），存储键集中在
`infrastructure/config/storageKeys.ts`。

---

## 4. 数据模型与存储

### 4.1 模型（新增 `domain/models/database.ts`，`domain/models.ts` 再导出）

```ts
export type DbDialect =
  | 'postgres' | 'mysql' | 'sqlite' | 'mssql' | 'mongodb' | 'redis' | 'jdbc';

export interface JdbcSettings {
  /** 引用 JdbcDriver.id */
  driverId: string;
  /** 例如 org.h2.Driver */
  driverClass: string;
  /** 任意 JDBC URL，例如 jdbc:h2:mem:demo;DB_CLOSE_DELAY=-1 */
  url: string;
  user?: string;
  /** 额外连接属性，按 key=value 传给 DriverManager */
  properties?: Record<string, string>;
  /** 内存库：保持会话常驻，连接断开时按需重放 initSql */
  inMemory?: boolean;
  initSql?: string;
}

export interface DbConnection {
  id: string;
  name: string;
  dialect: DbDialect;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  savePassword?: boolean;
  ssl?: 'disable' | 'prefer' | 'require' | 'verify-full';
  /** dialect === 'jdbc' 时必填 */
  jdbc?: JdbcSettings;
  /** 复用已有 SSH 主机做端口转发（可空） */
  sshHostId?: string;
  readOnly?: boolean;
  group?: string;
  order?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface JdbcDriver {
  id: string;
  name: string;
  /** 设备本地绝对路径；不参与云同步 */
  jarPaths: string[];
  driverClass: string;
  vendor?: string;
  /** 加载前提示用 */
  sha256?: string;
  createdAt?: number;
}
```

### 4.2 存储键与加密

- `infrastructure/config/storageKeys.ts`
  - `STORAGE_KEY_DB_CONNECTIONS = 'netcatty_db_connections_v1'`
  - `STORAGE_KEY_JDBC_DRIVERS = 'netcatty_jdbc_drivers_v1'`
- `infrastructure/persistence/secureFieldAdapter.ts`：新增 `encryptDbConnectionSecrets` /
  `decryptDbConnections`，只加密 `password`（`enc:v1:`，与 host 密码同一套）。
- 驱动 jar 本体存放在 `app.getPath('userData')/jdbc-drivers/<driverId>/`，仓库只存路径与 sha256。

### 4.3 同步与导入导出

- `domain/credentials.ts#stripSyncPayloadEncryptedCredentials`：剥离 `dbConnection.password`。
- `domain/sync.ts` 的 `SyncPayload` / `SYNC_PAYLOAD_ENTITY_KEYS` / `CLOUD_SYNC_PAYLOAD_ENTITY_KEYS`
  增加 `dbConnections`、`jdbcDrivers`；`domain/convergentSync/payload.ts` 的实体集合同步增加。
- `application/syncPayload.ts`：`SyncableVaultData` 增加两个字段与两处 builder。
- `useAutoSync.ts` 的载荷组装同步增加。
- **jarPaths / sha256 标记为设备本地**：跨设备同步只带驱动元数据（名称、驱动类），另一台设备
  首次使用时提示"重新选择 jar"。这与 host 密码的设备绑定语义一致。

### 4.4 useVaultState 扩展

在 `application/state/useVaultState.ts` 里按现有实体模板新增：

```ts
const [dbConnections, setDbConnections] = useState<DbConnection[]>([]);
const [jdbcDrivers, setJdbcDrivers] = useState<JdbcDriver[]>([]);
// 写路径：sanitize → 排序 → 只加密变更项 → commit → 写版本引用
// 读路径：decrypt → sanitize；storage 事件跨窗口同步；exportData/importData/clearVaultData 同步扩展
```

查询标签页、结果集、历史记录属于**会话态**，放 `useDatabaseState`（不落盘），只有"保存的查询"
需要持久化（`STORAGE_KEY_DB_SAVED_QUERIES`，可选）。

---

## 5. 驱动层设计

### 5.1 原生驱动（P1）

- 主进程 `electron/bridges/dbBridge.cjs` 暴露 IPC：
  - `netcatty:db:test`（连接测试，返回版本/耗时）
  - `netcatty:db:connect` / `netcatty:db:disconnect`
  - `netcatty:db:query`（`sql`、`maxRows`、`timeoutMs`，流式回传 rows 批次）
  - `netcatty:db:execute`（DML/DDL，返回 affectedRows）
  - `netcatty:db:metadata`（catalogs/schemas/tables/columns）
  - `netcatty:db:cancel`
- 连接池：每个 connectionId 一个懒加载池（pg `Pool`、mysql2 `createPool`），空闲 5 分钟回收。
- SQLite：优先 `node:sqlite`（Electron 42 内置），失败回退 `better-sqlite3`（需在
  `electron-builder` 的 `asarUnpack` + rebuild 流程中处理）。
- 结果集类型映射统一在 `domain/database/resultTypes.ts`：整数 → number（超 2^53 转 string）、
  numeric/decimal → string、timestamp → ISO string + 原始文本、bytea → base64、null → null。

### 5.2 SSH 隧道（P3 提前可做，收益大）

复用现有端口转发：调用 `sshBridge` 在目标主机上开一个本地监听端口的转发，
把数据库连接指向 `127.0.0.1:<本地端口>`；连接关闭时回收转发。
参考实现：`infrastructure/services/portForwardingService.ts`（现有 forward 生命周期与错误处理），
无需新写 SSH 逻辑。

---

## 6. JDBC 模式详细设计

### 6.1 为什么不用 node-jdbc / node-java

- 二者都依赖 JNI 原生桥（`node-java`），必须针对 Electron 的 ABI 重新编译，跨平台升级 Electron
  即失效；Windows 还需要 MSVC 工具链（本次 CI 已踩过同类坑）。
- JNI 崩溃会直接带崩主进程。

### 6.2 sidecar 形态

```
java -cp <netcatty-jdbc-bridge.jar>:<driverA.jar>:<driverB.jar> netcatty.bridge.Main --stdio
```

- 每个"JDBC 连接"一个 sidecar 进程；进程内可持有多个 Connection（同一驱动多库时复用）。
- 协议：按行分隔的 JSON（NLJSON）。请求 `{id, method, params}`，响应 `{id, result}` 或
  `{id, error:{code,message,sqlState}}`；结果集用 `{id, event:'rows', rows:[...]}` 分批推送，
  最后 `{id, result:{rowCount, affectedRows, elapsedMs}}`。
- 方法：`ping` / `listDrivers` / `connect` / `disconnect` / `query` / `execute` / `metadata` /
  `cancel` / `shutdown`。
- 取消：每条查询在独立线程执行，`cancel` 调 `Statement.cancel()`；主线程只做读写循环。
- 超时：`Statement.setQueryTimeout(seconds)`；sidecar 侧再加 watchdog，超时后 `cancel` 并回报。
- 类型映射：`java.sql.Types` → 带标记的 JSON（`{t:'i64',v:'...'}`），decimal 一律字符串，
  时间戳带 `timezone` 字段，避免 JS Number 精度丢失。

### 6.3 内存库会话

- `inMemory: true` 时：sidecar 持有 Connection 不关闭；用户切标签、改 SQL 都复用同一会话。
- 应用重启/进程崩溃后内存库必然丢失：连接关闭时提示"内存库数据仅在本次会话有效"；
  提供 `initSql`（建表 + 种子数据），在 `connect` 与自动重连时执行。
- 提供"导出为 SQL"按钮（`SCRIPT TO` for H2 / `mysqldump` 风格自研），把内存库落盘，避免误丢。

### 6.4 驱动管理

- 驱动登记：选择本地 jar → 读取 `META-INF/services/java.sql.Driver`（sidecar `listDrivers`）→
  自动填充驱动类名，也允许手填。
- 校验：记录 sha256；路径失效时连接报明确错误（"驱动 jar 不存在，请重新选择"）。
- 信任提示：首次加载某个 jar 前弹窗说明"jar 会在本机以当前用户权限运行"，确认后写入
  `trusted-driver-hashes`（设置项），后续同 hash 不再提示。
- 不自动下载驱动：避免许可与供应链问题；可在文档里给常用驱动的官方下载链接。

### 6.5 Java 运行时发现

> 三平台差异很大，完整探测顺序见 6.8 的平台表。

- 顺序：设置里的自定义 `javaPath` → `JAVA_HOME/bin/java` → 平台专属探测 → `PATH` 中的 `java`。
- 启动时 `java -version` 解析主版本，要求 ≥ 17；找不到时给出分平台安装引导
  （macOS: `brew install openjdk@21`；Windows: Adoptium MSI；Linux: 发行版包）。
- 可选（P4）：首启时提示一键下载 Adoptium JRE 到 `userData/jre/`（约 40–60MB/平台，
  需在设置中显式开启，避免安装包膨胀）。

### 6.6 安全边界

- jar = 任意代码执行。缓解：独立进程（崩溃不连带主进程）、启动前 sha256 提示、
  连接级"只读"开关、SQL 白名单仅用于"安全模式"提示而非真正的沙箱。
- 不向 sidecar 传 SSH 私钥等无关凭据；密码仅通过 stdin 协议传递，不进 argv（避免 `ps` 泄露）。
- 日志脱敏：`password`、连接串中的 `user:pass@` 一律打码。

### 6.7 与 DBeaver 的关系：JDBC 驱动管理就是"通用扩展点"

DBeaver 能做到"任意数据库 + 自备 jar"，靠的正是本节这套模型，而不是为每个库写原生适配
（DBeaver 全产品线只有 JDBC 一条通路，驱动就是它的插件）：

| DBeaver 概念 | 本设计对应物 | 说明 |
| --- | --- | --- |
| Driver（驱动定义） | `JdbcDriver` | 名称、驱动类、jar 路径列表、默认 URL 模板、默认端口 |
| Driver preset（内置预设） | `JDBC_PRESETS`（`domain/database/jdbcPresets.ts`） | Postgres/MySQL/SQLite/SQL Server/Oracle/H2/Derby/达梦/人大金仓 等，预填驱动类与 URL 模板 |
| Connection（连接） | `DbConnection.jdbc` | URL、user、properties、驱动引用 |
| Driver properties | `JdbcSettings.properties` | 任意 key=value 透传给 `DriverManager` |
| Driver jar 下载/管理 | 驱动管理器（本机路径 + sha256） | 本期不自动下载，只登记本地 jar |

因此 **JDBC 模式是"万能兜底"**：任何提供 JDBC 驱动的数据库（Oracle、达梦、人大金仓、
ClickHouse、DuckDB、H2、Derby…）都能零代码接入；原生驱动（pg/mysql2/…）只是为了更快的
启动速度、更好的类型映射和"免 Java 依赖"的默认体验，两者共用同一套连接模型与 UI。

驱动预设的数据结构：

```ts
export interface JdbcPreset {
  id: string;               // 'postgresql' | 'mysql' | 'oracle' | ...
  label: string;            // 展示名
  driverClass: string;      // org.postgresql.Driver
  urlTemplate: string;      // jdbc:postgresql://{host}:{port}/{database}
  defaultPort?: number;
  /** 官方下载页，仅作提示，不做自动下载 */
  downloadUrl?: string;
  /** 提示用户需要哪些 jar（部分驱动是多 jar） */
  requiredJarsHint?: string;
}
```

新增一种数据库 = 加一条 preset + 用户放一个 jar，不需要发版。

### 6.8 跨平台要点（Windows / Linux / macOS）

项目是三平台桌面应用，JDBC 链路必须三平台一致可用。sidecar 本身是纯 Java（一个 jar 通吃），
真正需要分平台处理的是**进程、路径、编码**三件事：

| 关注点 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Java 探测顺序 | 设置项 → `JAVA_HOME\bin\java.exe` → 注册表 `HKLM\SOFTWARE\JavaSoft\JDK` → `PATH` → `C:\Program Files\Eclipse Adoptium\*\bin\java.exe` | 设置项 → `JAVA_HOME/bin/java` → `/usr/libexec/java_home -v 17+` → `PATH` → `/opt/homebrew/opt/openjdk*/bin/java`、`/Library/Java/JavaVirtualMachines/*/Contents/Home/bin/java` | 设置项 → `JAVA_HOME/bin/java` → `PATH`（`/usr/bin/java` 可能是仅 JRE 的替代实现，需校验 `-version`） → `/usr/lib/jvm/*/bin/java` |
| classpath 分隔符 | `;` | `:` | `:` |
| 路径处理 | 反斜杠、盘符、空格、非 ASCII（`C:\Users\张三\drivers\ojdbc.jar`） | 空格（`/Applications/...`） | 空格、符号链接 |
| 启动方式 | `spawn('java.exe', ['-cp', cp, ...])`，**参数数组、不经 shell**，避免引号/空格问题 | 同左 | 同左 |
| stdio 编码 | 启动加 `-Dfile.encoding=UTF-8`；行尾可能是 `\r\n`，解析需 `trimEnd()` | UTF-8 | UTF-8 |
| 进程回收 | `taskkill /pid <pid> /T /F` 兜底 | `kill(-pid)` 进程组 | `kill(-pid)` 进程组 |
| 打包 | `electron-builder` win x64 | mac arm64 + x64 | linux x64 + arm64（AppImage/deb） |
| 原生模块风险 | `better-sqlite3` 需 MSVC 重编 | 需 xcode 工具链 | 需 build-essential；**优先 `node:sqlite` 规避** |

实现约束：

1. classpath 一律用 `path.delimiter` 拼接（`[bridgeJar, ...driverJars].join(path.delimiter)`），
   禁止硬编码 `:`。
2. 子进程用 `spawn(bin, args, { stdio: ['pipe','pipe','pipe'], windowsHide: true })`，不经过 shell；
   启动前用 `fs.existsSync` 校验每个 jar 并指出具体缺哪个文件。
3. jar 选择走 Electron 的 `dialog.showOpenDialog`（三平台原生对话框），存**绝对路径**；
   不复制进 `userData`（避免升级/卸载残留与许可问题），可选项"复制到应用数据目录"。
4. 语言/区域：sidecar 启动加 `-Duser.language=en -Duser.country=US`，避免系统区域影响
   数字/日期格式；日期一律 ISO-8601 传输。
5. 无 Java 时三平台都给可复制的安装命令/下载页；P4 再评估按平台下载 Adoptium JRE
   （`mac arm64`、`mac x64`、`win x64`、`linux x64`、`linux aarch64` 五个包，解压到
   `userData/jre/<platform>-<arch>/`，用 `jlink` 裁剪到约 45MB）。

验收标准：三个平台各跑一遍"登记 jar → 连接 H2 内存库 → 建表 → 插入 → 查询 → 导出"，
且中文路径（`C:\用户\驱动\ojdbc.jar`、`/home/用户/驱动/h2.jar`）下不失败。


---

## 7. UI 设计

### 7.1 入口

- `components/VaultView.tsx` 的 `VaultSection` 增加 `"databases"`；侧栏
  `components/vault/VaultViewLayout.tsx` 导航增加图标（`Database` from lucide）。
- 复用现有 aside panel 设计系统（`components/ui/aside-panel.tsx`）：连接列表 + 右侧详情面板，
  版式参考 `ProxyProfilesManager.tsx`（可复用实体 CRUD 的最接近模板）。

### 7.2 连接编辑器

- 基本：名称、类型（Postgres/MySQL/SQLite/MSSQL/MongoDB/Redis/JDBC）、主机、端口、库名、
  用户名、密码（保存开关）、SSL 模式、只读、分组。
- JDBC 分支：驱动下拉（来自 `JDBC_PRESETS`，DBeaver 风格的内置预设：Postgres/MySQL/
  MariaDB/SQLite/SQL Server/Oracle/H2/Derby/达梦/人大金仓…）+ "添加驱动…"（选 jar 后
  自动探测驱动类）、驱动类（可手改）、JDBC URL（按预设模板预填 `{host}/{port}/{database}`）、
  属性表（任意 key=value）、内存库开关、初始化 SQL。
- 底部："测试连接"（显示版本/耗时/错误原文）、"保存"。

### 7.3 SQL 工作台

- 布局：左侧 schema 树（表/列/索引，懒加载）；中间编辑器（CodeMirror 6，SQL 高亮、方言关键字、
  `Cmd/Ctrl+Enter` 执行选中）；下方结果区（Tab：结果 / 消息 / 历史）。
- 结果表格：虚拟滚动，列宽自适应，单元格右键复制（值/CSV/INSERT），NULL 显示为灰色 `NULL`。
- 执行反馈：`N rows in 123 ms`；错误显示 `SQLSTATE` 与位置。
- 多标签：每个标签独立连接与事务状态；关闭标签前提示未提交事务。

### 7.4 与现有 SSH 功能的联动

- 连接编辑器"通过 SSH 主机访问"下拉复用 host 列表（支持分组树选择）。
- 从主机详情页可直接"打开该主机的数据库"（若配置过 sshHostId）。
- 数据库标签页与终端标签页共用 workspace 分屏能力（`domain/workspace.ts`）。

---

## 8. 测试计划

| 层 | 内容 | 方式 |
| --- | --- | --- |
| domain | JDBC URL 校验、驱动类名校验、结果类型映射、连接串脱敏 | `domain/database/*.test.ts`（node --test + tsx） |
| bridge | `dbBridge.cjs` 的错误映射、池回收、取消 | `electron/bridges/dbBridge.test.cjs` |
| sidecar 协议 | 用假 java（node 脚本模拟 NLJSON）验证 framing、超时、取消、错误透传 | `electron/bridges/jdbcBridge.test.cjs` |
| 真库集成 | Postgres/MySQL/SQLite 容器或本地实例 | 环境变量开关，`npm run test:db`（CI 默认跳过） |
| JDBC 集成 | H2 jar + `jdbc:h2:mem:` 建表 → 插入 → 再查询 | 需要 java，`NETCATTY_TEST_JDBC=1` 时运行 |
| UI | 连接表单校验、结果表格渲染 | `components/databases/*.test.tsx` + i18n parity |

---

## 9. 功能点与工期

### 9.1 功能点清单（共 56 项）

| 模块 | # | 功能点 | 人日 |
| --- | --- | --- | --- |
| A 基础管道 | 1–6 | 数据模型/存储键/加密适配/`useVaultState` 实体/云同步三向合并/导入导出/功能开关 | 2 |
| B 连接管理 | 7–16 | 数据库分区列表、新建编辑克隆删除、分组排序、**驱动二段式选择**、JDBC 驱动登记（选 jar、探测驱动类、sha256）、参数表单（host/port/db/user/pass/SSL）、测试连接、SSH 隧道、密码保存、搜索与空态 | 4 |
| C 查询工作台 | 17–28 | 多标签、SQL 编辑器（高亮/补全/格式化）、执行选中与全部、结果表格（虚拟滚动/复制/列宽）、限制行数与分页、消息面板、错误面板（SQLSTATE/位置）、取消、历史、保存查询、连接状态重连、事务提交/回滚 | 6 |
| D 内置驱动 | 29–36 | PG / MySQL-MariaDB / Oracle Thin / SQLite、统一类型映射、连接池与超时、TLS、驱动冒烟矩阵 | 4 |
| E JDBC | 37–47 | Java 探测（三平台）、sidecar 工程与构建、JSON-RPC 协议、connect/query/execute/metadata、流式结果、取消超时、驱动预设表、驱动管理器页、内存库会话保持 + initSql、内存库导出 SQL、三平台打包烟测 | 8 |
| F 增强 | 48–56 | schema 树、表数据浏览、导出 CSV/JSON/INSERT、执行 SQL 文件、只读模式、危险 SQL 确认、AI 生成/解释 SQL、主机详情入口、五语言 i18n 与文档 | 7 |

### 9.2 分阶段与工期

| 阶段 | 范围 | 交付物 | 人日 |
| --- | --- | --- | --- |
| MVP | A + B + C + D(PG/MySQL/Oracle/SQLite) | 可日常用的查询工作台，**不需要 Java** | 15 |
| +JDBC | E（含三平台烟测） | 任意 JDBC 驱动 + 内存库 | +8（累计 23） |
| 完整 | F | 接近成熟客户端 | +7（累计 30） |
| 可选 | P4 AI / ER 图 | 差异化 | +4 |

节奏换算：单人全职约 **MVP 3 周 / 全量 6 周**；若由我连续实现并配你验收，日历时间约
**MVP 5–7 天、加 JDBC 再 4–6 天、全量 12–15 天**，前提是 Electron 原生模块与 Oracle Thin
模式不出现意外（建议预留 20% buffer）。

### 9.3 新增连接的两段式 UI

```
[新建数据库连接]
  ① 类型
     ● 内置（推荐，免 Java）
        PostgreSQL   MySQL/MariaDB   Oracle   SQLite   (SQL Server / MongoDB / Redis)
     ○ 其他数据库（JDBC 驱动 jar）
  ② 连接
     内置：主机 / 端口 / 库名 / 用户名 / 密码 / SSL / [x] 通过 SSH 主机访问
     JDBC：驱动 [Postgres ▾ | 添加驱动…]  驱动类 [org.postgresql.Driver]
           JDBC URL [jdbc:postgresql://{host}:{port}/{db}]
           属性 [key=value +]   [x] 内存库  初始化 SQL [ ... ]
  ③ [测试连接]  ✓ 12 ms · PostgreSQL 16.2      [保存]
```

- 内置驱动选择后**无需任何 jar**：PG 用 `pg`、MySQL 用 `mysql2`、Oracle 用 `oracledb` Thin
  模式（纯 JS，不需要 Instant Client）、SQLite 用 `node:sqlite`。
- 只有"其他数据库"才进入 jar 流程：选 jar → 自动读 `META-INF/services/java.sql.Driver`
  填驱动类 → 预填 URL 模板 → 需要 Java 17+（三平台探测见 6.8）。
- 驱动管理器（侧栏"数据库 → 驱动"或设置页）：已登记 jar 的路径、sha256、驱动类、
  使用中的连接数、删除与"重新选择路径"。

分支策略：从 `main` 切 `feat/database-workbench`，与 #3926 完全隔离；功能默认由设置项
`experimental.databaseWorkbench` 控制（默认关），避免影响现有用户与上游合并。

---

## 10. 风险与开放问题

**风险**

1. `better-sqlite3` 原生模块与 Electron 42 ABI：优先用内置 `node:sqlite`，否则需接入
   `@electron/rebuild` 并调整打包配置（本次 CI 已遇到 Windows 工具链问题，需预留时间）。
2. Oracle `oracledb` Thin 模式需要在 Electron 渲染层之外验证：Thin 是纯 JS，但包内仍带
   Thick 用原生二进制，打包时要确保 `asarUnpack` 正确且不会在启动时加载 native。
3. 用户机器没有 Java：JDBC 功能必须给出清晰的降级路径与安装引导（三平台分别给命令）。
4. 三平台差异：classpath 分隔符、编码、进程树回收、中文路径——已在 6.8 列表化，但必须
   在三平台各跑一遍真实烟测，不能只靠单测。
5. 大结果集：默认 `maxRows=1000` + 分批推送 + 虚拟滚动；提供"导出全部"走流式写文件。
6. 自备 jar 的安全与合规：只做提示与哈希记录，不做沙箱承诺。
7. 范围膨胀：数据库工作台很容易做成"半个 DBeaver"，MVP 必须严格限定在连接 + 查询 + 结果。

**开放问题（需要拍板）**

1. 首批内置库已定：PostgreSQL / MySQL(MariaDB) / Oracle / SQLite；SQL Server、MongoDB、
   Redis 放增强阶段。是否确认？
2. JDBC 是否接受"必须自备 Java"？还是要做 Adoptium JRE 一键下载（体积 +50MB，需按
   mac arm64 / mac x64 / win x64 / linux x64 / linux arm64 各打一份）？
3. 内存库的主要用途是"临时测试"还是"当作轻量本地库"？前者可以关闭即销毁，后者需要导出/持久化策略。
4. 数据库连接是否需要随云同步（含密码的设备绑定语义）？建议同步连接元数据、不同步明文密码。
5. 是否允许把该功能做成 fork 专属（不进上游 PR）？若希望上游接受，需要拆成多个小 PR。

---

## 11. 附：与 navop 的产品差异点（自研时的取舍）

navop 覆盖 MySQL/PostgreSQL/SQLite/MSSQL/Oracle/DuckDB/ClickHouse/达梦/人大金仓/IoTDB 等，
并有 SSH/SFTP/监控/AI 一体化。NetCatty 的差异化优势是**已有的 SSH 主机链、端口转发、
终端与 AI Agent 集成**，因此数据库功能应优先做"经 SSH 访问内网库"和"AI 直接查库"，
而不是堆驱动数量——这也是不在 P1 支持 Oracle/达梦的原因。

---

## 12. 实施记录（2026-10）

### 12.1 已完成（MVP 主体，分支 `feat/database-workbench`）

| 模块 | 状态 | 落点 |
| --- | --- | --- |
| A 基础管道 | ✅ | `domain/models/database.ts`、`infrastructure/config/storageKeys.ts`（`netcatty_db_connections_v1`、`netcatty_db_query_history_v1`）、`secureFieldAdapter` 加密、`useVaultState` 实体、sync/syncMerge/convergent sync/导出导入 |
| B 连接管理 | ✅（分组排序/克隆见 12.3） | `components/databases/DatabasesManager.tsx`、`DatabaseConnectionDialog.tsx` |
| C 查询工作台 | ✅（补全、分页见 12.3） | `components/databases/SqlWorkbench.tsx`、`application/state/useDatabaseWorkbench.ts`、`useSqlHistory.ts` |
| D 内置驱动 | ✅ PG/MySQL/MariaDB/Oracle Thin/SQLite | `electron/bridges/dbBridge.cjs`（会话复用、超时、取消、行数上限） |
| E JDBC | ✅ 阶段二（驱动管理 UI 待补） | `electron/jdbc-sidecar/`、`electron/bridges/jdbcSidecar.cjs`、`javaRuntime.cjs` |
| F 增强 | ⏳ 阶段三 | 已提前完成 CSV 导出 |
| 附加 | ✅ 经 SSH 主机访问数据库 | `infrastructure/services/databaseTunnelService.ts` + `sshHostId` |

### 12.2 与设计的偏差

1. **SSH 隧道实现位置**：设计写的是主进程内建隧道，实际复用渲染层既有的
   `portForwardingService.startPortForward`（临时规则 `db-tunnel-<connectionId>`，
   `localPort: 0` 由主进程分配后回传），这样跳板机链、代理、Known Hosts、
   TOTP 全部复用现有能力，不必在主进程重写 SSH 认证。
2. **SQL 编辑器**：设计提到 CodeMirror，实际复用仓库已有的 Monaco
   （`components/scripts/ScriptCodeEditor.tsx`，新增 `sql` 语言与选区读取）。
3. **查询历史**：存放在 localStorage（`netcatty_db_query_history_v1`），不进加密
   vault、不同步——历史里可能含敏感字面量，先保持本机。
4. **事务**：新增主进程 `netcatty:db:control`（begin/commit/rollback），
   PG/MySQL/SQLite 显式事务，Oracle 依赖隐式事务 + commit/rollback。

### 12.3 阶段一已完成（2026-10 补充）

- 经 SSH 主机访问数据库（`databaseTunnelService`，localPort=0 自动分配）
- 连接克隆、最近使用时间
- 表结构树（左侧按 schema 分组，点击表名生成 `select * limit 100` 并执行）
- 查询历史、事务 begin/commit/rollback、CSV 导出、执行选中 SQL

### 12.6 阶段三：驱动与内置库扩展（2026-10）

- JDBC 驱动管理器：`domain/database/jdbcDrivers.ts` + `components/databases/JdbcDriversDialog.tsx`，
  驱动（名称/厂商预设/驱动类/多 jar）注册一次即可被所有 JDBC 连接复用；驱动注册表存在
  `netcatty_jdbc_drivers_v1`，随 vault 导出导入，但**不进云同步**（jar 路径是设备本地）。
- SQL Server 内置驱动（`tedious`，纯 JS）：默认端口 1433，支持加密开关、表结构树、
  取消/关闭；事务由其自身管理。
- 修正连接编辑器驱动类型列表遗漏 JDBC 的问题。
- 初始化 SQL 重放：会话首次使用前按分号拆分执行 `initSql`（内存库重建结构），失败在连接阶段报错。

### 12.7 尚未实现（原 12.3 的剩余项）

- 连接克隆、分组/排序 UI、收藏与最近连接
- 编辑器自动补全（表/列名）、结果分页与列宽拖拽持久化
- 驱动冒烟矩阵（对真实 PG/MySQL/Oracle 实例的 CI 任务）
- 设置项开关 `experimental.databaseWorkbench`

### 12.4 阶段二（JDBC）实施结果

已按「源码提交 + 构建时用 javac 编译」落地，实测 H2 内存库跑通建表/插入/查询/
元数据（`NetcattyJdbcSidecar` 类，7.3 KB jar）：

- 协议：一行一个请求 `<id>\t<METHOD>\tkey=base64(value)...`；响应 `OK/ERR/COLS/ROW`，
  主进程侧 `jdbcSidecar.cjs` 负责关联与流式收集，`javaRuntime.cjs` 负责探测 Java
  （设置项 → JAVA_HOME → PATH → 平台默认目录，并用 `java -version` 验证）。
- 构建：`scripts/build-jdbc-sidecar.cjs` 由 `prebuild` 自动调用，产出
  `dist/jdbc-sidecar/netcatty-jdbc-sidecar.jar`；无 JDK 时只警告不失败。
  打包进 asar 后，运行时首次使用会把 jar 解到 `userData/jdbc-sidecar/` 再启动。
- CI：`fork-package.yml` 增加 `actions/setup-java@v4`（temurin 21）。
- 驱动 jar 由用户自备：连接编辑器可选多个 jar，驱动类可留空（走 ServiceLoader 发现）。
- 驱动预设：`domain/database/jdbcPresets.ts` 覆盖 MySQL / MariaDB / PostgreSQL / Oracle /
  SQL Server / H2 / ClickHouse / 达梦 / 人大金仓，选中即填驱动类与 URL 模板，并给出官方下载页。
- 待补：驱动管理器独立页面（把 jar 注册为可复用实体 `JdbcDriver`）、
  `jdbcProperties` 高级表格、内存库 `initSql` 重放与导出 SQL。

### 12.5 原始设计要点（保留）

由于构建机与本机都没有 JDK，sidecar 采用「源码 + 构建时编译」：
`electron/jdbc-sidecar/src/NetcattyJdbcSidecar.java` 提交源码，`npm run build:jdbc-sidecar`
用 `javac` 产出 `netcatty-jdbc-sidecar.jar`，打包时作为 `extraResources`；CI 在
`fork-package.yml` 里先 `actions/setup-java` 再构建。运行时探测顺序：
`NETCATTY_JAVA_HOME` → `JAVA_HOME` → PATH → 三平台默认安装位置；找不到时给出
安装引导而不是静默失败。
