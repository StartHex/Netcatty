# 分组统一密码 + 内置 OTP 验证器 设计方案

Status: **draft — 等待确认后实施**
Baseline: `binaricat/Netcatty` `d45fb7537`（tag `v1.1.88`，本地 fork 基线）
Scope: 仅设计，不含实现代码
Last updated: 2026-10-25

---

## 0. 结论先行

| 决策点 | 结论 |
| --- | --- |
| 统一密码开关落点 | `GroupConfig.unifiedPassword?: boolean`，默认 `false`；分组设置 → SSH 凭据区 |
| 统一密码权威值 | 复用已有的 `GroupConfig.password`（已加密、已参与继承），不新增第二份密码字段 |
| 传播作用域 | "最近的已开启统一密码的祖先分组"（nearest enabled group wins），避免子组互相覆盖 |
| 传播触发 | 只由用户显式改密码的动作触发（主机详情保存 / SSH 登录保存密码 / 分组设置保存）；**导入、云同步、恢复不触发** |
| OTP 数据形态 | 新增独立 Vault 实体 `OtpAuthenticator`，独立存储键、独立加密、独立管理页；主机通过 `otpAuthenticatorId` 引用 |
| 连接期如何取值 | **materialize**：选择验证器时把 `otpauth://` URI 写进 `host.totp.uri`（与现有 ProxyProfile 的 `proxyConfig` 落地方式一致），因此 7 处连接调用点（6 个文件）、主进程 `totpBridge`、`KeyboardInteractiveModal` 全部不改 |
| 类型支持 | v1 实现 TOTP（SHA1/SHA256/SHA512 × 6/7/8 位 × 自定义周期）；HOTP 在模型里预留 `type` / `counter`，是否本期做见第 7 节问题 3 |

---

## 1. 背景与目标

### 1.1 需求一：分组统一密码

- 同一个分组提供一个开关，默认关闭。
- 开关开启后，在该分组内任意主机上修改密码，都同步到"这个目录的每台主机"。
- 目标用户场景：实验室/多台同账号机器、批量改密码后不想逐台改。

### 1.2 需求二：内置 OTP 验证器

- 应用内置 OTP 验证器管理：可以建多个验证器，每个含 密钥、类型、算法、位数、时间间隔。
- SSH 主机设置里可以选择某个验证器。
- 目标用户场景：堡垒机 / JumpServer 在密码之后要求输入 6 位动态码。

### 1.3 非目标（本期不做）

- 不做密码定期轮换、密码强度策略、密码历史。
- 不改变现有"设备绑定加密 + 云同步不传明文密码"的安全模型。
- 不把验证器密钥暴露给 AI / MCP / CLI 的 vault 接口。
- 不做 HOTP 计数器自动递增服务端语义（若确认需要 HOTP，见 4.11）。

---

## 2. 现状梳理（决定改法的关键事实）

### 2.1 分组模型与继承

- `GroupConfig`：`domain/models/connection.ts:436`。已有 `path / username / password / savePassword / authMethod / identityId / port / protocol / proxyProfileId / ...`，**没有** OTP 与统一密码字段。
- `domain/groupConfig.ts`：
  - `resolveGroupDefaults()` 沿 `A` → `A/B` → `A/B/C` 祖先链合并，子组覆盖父组。
  - `applyGroupDefaults(host, defaults)` 的 `INHERITABLE_KEYS` 包含 `password / savePassword / authMethod / identity*` 等。
  - 因此**新建**主机天然继承分组密码；但**已有**主机各自持有密码，分组密码不会回头覆盖它们 —— 这正是统一密码功能要补的部分。
- 分组是"路径即身份"：主机用 `Host.group: string` 指路径，子组用 `A/B` 前缀表达；没有 group id。

### 2.2 主机密码的持久化写入路径（只有 3 条）

| 路径 | 位置 | 说明 |
| --- | --- | --- |
| 主机详情保存 | `components/HostDetailsPanel.tsx`（`password: form.savePassword === false ? undefined : form.password`）→ 3 个挂载点：`components/vault/VaultViewLayout.tsx:1500`、`application/app/AppHostEditorLayer.tsx:191`、`components/SelectHostPanelContent.tsx:656` | 最终都走 `onUpdateHosts` |
| 键盘交互登录时"保存密码" | `application/app/AppHandlers.ts:386-433`（`handleKeyboardInteractiveSubmitImpl`） | 直接 `updateHosts(...)`，且 `allowSavePassword !== false` 才保存 |
| 分组默认值保存 | `components/GroupDetailsPanel.tsx` → `components/VaultView.tsx:1188 handleSaveGroupConfig` | 写入 `groupConfigs`，不写主机 |

其余（导入、云同步、恢复、批量编辑）走 `updateHosts` 的批量路径 —— 必须**不**触发传播。

### 2.3 已有 TOTP 能力（功能二其实已有一半）

- 模型：`domain/models/connection.ts:161 HostTotpConfig { uri; autoSubmit?; promptPattern? }`，`Host.totp?`；秘密就藏在 `otpauth://` URI 里。
- 主进程：`domain/totp.shared.cjs`（BASE32、SHA1/256/512、6-8 位、period 1-300、`generateTotp`、`buildOtpauthUri`、`parseOtpauthUri`、`previewTotpText`、自动填充策略）；`electron/bridges/totpBridge.cjs` 暴露 `netcatty:totp:preview`、`netcatty:totp:scan-screen`。
- 渲染进程解析：`domain/totpConfig.ts` 的 `connectionTotpFields(host)`（`:19`）；7 处调用（6 个文件）：
  - `components/terminal/runtime/createTerminalSessionStarters.ts:483`（跳板机）、`:711`（目标机）
  - `application/state/sftp/useSftpHostCredentials.ts:125`、`:187`
  - `infrastructure/services/portForwardingService.ts:1002`（跳板）、`:1138`（目标）
  - `components/KeychainExportPanel.tsx:262`（一次性 SSH exec 装公钥）
- 登录弹窗：`components/KeyboardInteractiveModal.tsx` 已支持 `request.totpUri`、OTP 提示词匹配、一键填充、自动提交。
- 主机编辑 UI：`components/HostTotpFields.tsx`，只支持"本机单条密钥"（手输 base32 / 二维码 / 截屏扫码），`components/HostDetailsConnectionSections.tsx:744` 挂载。

结论：缺的是"可复用的验证器实体 + 管理页 + 主机按引用选择"，而不是重写 TOTP 引擎。

### 2.4 存储 / 加密 / 同步（新增实体的固定动作清单）

- 存储键集中在 `infrastructure/config/storageKeys.ts`（已有 `STORAGE_KEY_HOSTS='netcatty_hosts_v1'`、`STORAGE_KEY_PROXY_PROFILES='netcatty_proxy_profiles_v1'`、`STORAGE_KEY_GROUP_CONFIGS='netcatty_group_configs_v1'`）。
- 内存里是明文；落盘时由 `infrastructure/persistence/secureFieldAdapter.ts` 逐字段 `encryptField()`（走主进程 `credentialsEncrypt`，密文带 `enc:v1:` 前缀、与设备绑定）。主机侧 `encryptHostSecrets` 已覆盖 `totp.uri`，分组侧 `encryptGroupConfigSecrets` 已覆盖 `password`。
- 云同步：`domain/sync.ts:273 SyncPayload` + `:479 SYNC_PAYLOAD_ENTITY_KEYS`；`application/syncPayload.ts` 负责 build/apply；`domain/convergentSync/payload.ts:43 CONVERGENT_ENTITY_COLLECTIONS` 是 CRDT 的实体白名单；上传前 `domain/credentials.ts:203 stripSyncPayloadEncryptedCredentials` 会剥离设备绑定密文（因此密码本就不跨设备同步）。
- 备份/导出：`application/state/useVaultState.ts:2286 exportData` / `:2304 importData`，实体逐项路由。
- i18n：`application/i18n/locales/{en,zh-CN,zh-TW,ru,es}` 各 7 个命名空间文件（`core.ts / vault.ts / terminal.ts / ...`），`localeParityLocales.test.ts` + 逐特性 locale 测试要求 5 语言键齐、非空。

---

## 3. 功能一：分组统一密码

### 3.1 数据模型

```ts
// domain/models/connection.ts — GroupConfig 追加
export interface GroupConfig {
  // ...已有字段
  /**
   * 开启后，本组（含未自行开启的子组）内的主机共享同一密码。
   * 默认 false/undefined。权威值 = 本 GroupConfig.password。
   */
  unifiedPassword?: boolean;
}
```

- 不新增密码字段：`GroupConfig.password` 已经是"组默认密码"，已有加密、已有继承、已在 `stripSyncPayloadEncryptedCredentials` 中脱敏。
- `sanitizeGroupConfig()` 需要保留该布尔字段（`domain/groupConfig.ts`）。
- 需加入 `GroupConfig` 的导出/导入与 `unifiedPassword` 的布尔归一化：`undefined/true/false` → 仅 `true` 视为开启。

### 3.2 核心语义

1. **管理者（manager）**：对某台主机，沿自身分组向上找，第一个 `unifiedPassword === true` 的分组。没有则视为"不受管理"。
2. **传播范围**：`host` 的 manager 路径 === 本次改密码的主机的 manager 路径。
   - 例：`A`(开)、`A/B`(开)、`A/B/C`(关)；改 `A/B/C` 里主机密码 → manager 是 `A/B`，只同步 `A/B` 自己 + `A/B/C` + `A/B/D` 的主机，**不动** `A` 其它主机。
   - 这样嵌套开启的组不会互相覆盖，且修改后各组"组默认密码"与组内主机始终一致。
3. **权威值落库**：传播同时把 `manager.password` 更新为新密码（新主机继承、导出/同步一致）。
4. **跳过规则**：
   - `host.savePassword === false` → 跳过（用户明确不落盘），UI 提示"已跳过 N 台未保存密码的主机"。
   - 密码是 `enc:v1:` 占位符（云同步还原、本机解密失败）→ 跳过。
   - 新密码为空（用户清空密码框）→ **不传播**，避免误清空整个目录；只更新分组默认密码。
5. **不传播**：`updateHosts` 的批量路径（导入 / 云同步 / 恢复 / 批量编辑）。统一密码只在"单台主机 + 用户显式改密码"时生效。

### 3.3 传播算法（纯函数，`domain/groupUnifiedPassword.ts`）

```ts
export function isSameOrDescendantGroup(candidate: string, root: string): boolean {
  if (!candidate || !root) return false;
  return candidate === root || candidate.startsWith(`${root}/`); // 注意 "A" vs "A-B" 的边界
}

export function resolveUnifiedPasswordManager(
  hostGroup: string | undefined,
  configs: readonly GroupConfig[],
): GroupConfig | undefined {
  // path "A/B/C" -> ["A/B/C", "A/B", "A"]
  for (const path of groupAncestorChain(hostGroup)) {
    const config = byPath.get(path);
    if (config?.unifiedPassword === true) return config;
  }
  return undefined;
}

export interface UnifiedPasswordPlan {
  managerPath: string;
  nextHosts: Host[];           // 已替换密码
  nextConfigs: GroupConfig[];  // manager.password 已更新
  updatedHostIds: string[];
  skippedUnsaved: string[];
}

export function planUnifiedPasswordWrite(input: {
  hosts: readonly Host[];
  configs: readonly GroupConfig[];
  changedHost: Host;
  password: string;
}): UnifiedPasswordPlan | null;
```

判定流程：

```text
password 为空 / 等价明文与旧值相同 -> return null（无变化）
manager = resolveUnifiedPasswordManager(changedHost.group, configs)
manager 不存在或 manager.unifiedPassword !== true -> return null
targets  = hosts.filter(h =>
             h.savePassword !== false
             && !isEncryptedCredentialPlaceholder(h.password)
             && resolveUnifiedPasswordManager(h.group, configs)?.path === manager.path)
nextHosts = hosts.map(h => targets.includes(h) ? { ...h, password } : h)
nextConfigs = configs.map(c => c.path === manager.path ? { ...c, password } : c)
```

落库顺序：先 `updateGroupConfigs(nextConfigs)` 再 `updateHosts(nextHosts)`（两者都在 `withVaultImportLock` 语义下顺序执行；中途失败可由下一次改密码自愈，不会产生"主机密码与组密码不一致且无法修复"的死状态）。

### 3.4 触发点与调用链

新增 `useVaultState` 动作（跨实体，必须放在 hook 层）：

```ts
/** 单台主机保存；若命中统一密码分组则顺带同步同组主机与组默认密码 */
saveHostWithUnifiedPassword(nextHost: Host): Promise<{ syncedCount: number; skippedCount: number } | null>

/** 分组设置保存：开启开关 / 修改分组密码时把权威值刷到组内主机 */
applyGroupUnifiedPassword(groupPath: string, password: string): Promise<{ syncedCount: number; skippedCount: number }>
```

调用点改造：

| 场景 | 改动 |
| --- | --- |
| Vault 主机详情保存 | `VaultViewLayout` 的 `onSave` 由 `onUpdateHosts(prev => upsertHostById(...))` 改为优先调用 `onSaveHostWithUnifiedPassword`（无 manager 时内部退化为普通 `updateHosts`），toast 提示同步台数 |
| 终端里的主机编辑 | `AppHostEditorLayer.tsx:191` 同样接 `onSaveHostWithUnifiedPassword` |
| SSH 登录保存密码 | `AppHandlers.ts:386-433` 把 `updateHosts` 换成传入的 `saveHostPassword(hostId, password)`；`AppView` / `AppSideEffects` 增加一层 prop 透传 |
| 分组设置保存 | `VaultView.handleSaveGroupConfig`：`unifiedPassword === true && password` 时调用 `applyGroupUnifiedPassword`；若开启但密码为空，toast 提示"请先填写分组密码" |
| 关闭开关 | 只写 `unifiedPassword: false`，不改任何主机密码（保留现状，避免"关开关 = 重置密码"的惊吓） |
| 批量导入 / 云同步 / 恢复 | 不动 `updateHosts`，天然不传播 |

**为什么不直接塞进 `updateHosts`**：`updateHosts` 是导入、同步、恢复、批量编辑的共同出口，用"diff 里只有一台主机变了"来判断语义太脆（云同步合并也可能只变一台），误传播会改写用户数据；显式动作可测试、可审计。

### 3.5 UI

1. 分组设置 → SSH 凭据区（`components/GroupSshSettingsSection.tsx`，密码框在 `:129-140`，`ToggleRow` 在 `:20`）：

```text
[Switch] 统一密码
         开启后，修改本组（含子分组）任一主机的密码，会同步到该分组内所有主机。
         [i] 当前管理 12 台主机 / 3 台未保存密码将被跳过
```

   - 开关默认关；开启时若分组密码为空，行内提示"请先设置分组密码"。
   - `components/GroupDetailsPanel.tsx` 的 `GroupConfig` 组装处加 `...(form.unifiedPassword === true && { unifiedPassword: true })`（关闭时写 `false` 或省略，保持 payload 精简；写 `false` 更利于"关闭"语义持久化 —— 采用显式 `false`）。
   - 开启后第一次保存：确认弹窗"将把分组密码写入 12 台主机？"（列出跳过数量），确认后传播。

2. 主机详情 → 凭据区密码框旁加只读徽标：`由分组「A/B」统一管理`（点击可跳到分组设置）。当主机 manager 存在但 `savePassword === false` 时显示"该主机不保存密码，不会被同步"。

3. i18n 新增键（5 语言）：
   - `vault.groups.unifiedPassword.label/hint/enabledHint/managedCount/skippedCount/noPassword/confirmTitle/confirmBody/syncedToast`
   - `hostDetails.password.unifiedBadge/unifiedSkipped`

### 3.6 边界情况

| # | 场景 | 行为 |
| --- | --- | --- |
| 1 | 关闭开关后改密码 | 不传播；组默认密码仍按普通字段保存 |
| 2 | 开启但组密码为空 | 不传播 + 提示 |
| 3 | 主机 `savePassword === false` | 跳过并在 toast 中给数量 |
| 4 | 主机密码为 `enc:v1:` 占位符 | 跳过（无法比较/解密） |
| 5 | 用户清空密码 | 不传播，仅更新组默认密码（文档明示） |
| 6 | 嵌套开启分组 | 最近祖先优先；父组改动不覆盖子组 |
| 7 | 路径前缀相似 `A` / `A-B` | 用 `${root}/` 边界判断 |
| 8 | 分组重命名 / 移动 | 不做数据迁移（路径动态解析）；重命名后不自动重新对齐，提示可点"立即同步一次" |
| 9 | 云同步 / 导入 / 恢复 | 不传播；若同步后主机密码漂移，下一次显式改密码即自愈 |
| 10 | 主机从其它组移入统一组 | v1 不自动改密码（避免移动即改密）；P1 可选"移入时对齐"（见问题 2） |
| 11 | 密码相同（未变） | `password` 未变化时 `planUnifiedPasswordWrite` 返回 null，不写盘 |
| 12 | 同一批里多台主机改密码 | 各自走一次动作，后写覆盖先写；批量编辑走 `updateHosts`，不传播 |

### 3.7 测试计划

- `domain/groupUnifiedPassword.test.ts`
  - manager 解析：无分组 / 单层 / 多层 / 嵌套开启 / `A` vs `A-B` / 空 group。
  - 目标集合：兄弟组、子组、子组再开启、`savePassword === false`、占位符。
  - 空密码、密码未变、非法 group 路径。
- `application/state/useVaultState.unifiedPassword.test.ts`：动作同时写 hosts + groupConfigs；无 manager 时退化为普通更新；失败顺序。
- `components/GroupSshSettingsSection.test.tsx`：开关渲染、默认关、payload 含 `unifiedPassword`。
- `components/HostDetailsPanel.test.tsx`（或现有保存测试）：带 manager 的主机保存调用新动作。
- `application/app/AppHandlers.test.ts`：KI 保存密码走 `saveHostPassword`，`allowSavePassword === false` 不保存也不传播。
- `application/i18n/locales/*` 新增键的 5 语言断言。

---

## 4. 功能二：内置 OTP 验证器

### 4.1 数据模型

```ts
// domain/models/otpAuthenticator.ts（新文件，从 models.ts 导出）
export type OtpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';
export type OtpAuthenticatorType = 'totp' | 'hotp';

export interface OtpAuthenticator {
  id: string;
  /** 用户可读名称，如 "JumpServer 生产" */
  label: string;
  /** 可选：issuer / account，来自 otpauth URI 或手填 */
  issuer?: string;
  account?: string;
  type: OtpAuthenticatorType;
  /** Base32（无空格、大写）。落盘加密；云同步脱敏后可能缺失 */
  secret?: string;
  algorithm: OtpAlgorithm;
  digits: 6 | 7 | 8;
  /** 秒，仅 TOTP；范围 1-300，UI 提供 15/30/60 + 自定义 */
  period: number;
  /** 仅 HOTP 预留 */
  counter?: number;
  order?: number;
  createdAt?: number;
  updatedAt?: number;
}
```

主机引用：

```ts
// domain/models/connection.ts — Host 追加
export interface Host {
  // ...
  /** 选中的可复用 OTP 验证器；同时 host.totp.uri 会被 materialize 成结果 */
  otpAuthenticatorId?: string;
}
```

`HostTotpConfig`（`:161`）**不改**：`uri` 继续是唯一连接期输入，`autoSubmit` / `promptPattern` 仍是每主机设置。

### 4.2 为什么用 materialize（而非连接期按 id 解析）

现有 ProxyProfile 就是这个模式：主机保存时把 `proxyProfileId` 对应的配置复制进 `host.proxyConfig`（`prepareProxyConfigForSave`），连接期只读 `host.proxyConfig`；删除 profile 时清理引用。

照搬这个模式后：

- `connectionTotpFields(host)` 的 7 个调用点（6 个文件）、主进程 `sshBridge`/`sshAuthHelper`/`totpBridge`、`KeyboardInteractiveModal` **一行都不用改**；
- 跳板机、SFTP、端口转发、Keychain 一次性 exec 全部自动生效；
- 代价是密钥在 vault 里存在两份（验证器本体 + 主机 materialized URI），需要"编辑/删除验证器时回写引用主机"。两份都在同一加密层内，风险可接受；换来的改动面小一个量级。

连接期按 id 解析（Option B）更"单一事实来源"，但要给 `createTerminalSessionStarters`、`useSftpHostCredentials`、`portForwardingService`、`KeychainExportPanel` 全部加 `authenticators` 上下文，并把 `KeyboardInteractiveModal` 的 `totpUri` 来源也换掉 —— 本期不做，作为后续可选的收敛方向（记在 4.11）。

### 4.3 域模块

新增 `domain/otpAuthenticator.ts`（纯 TS，渲染进程与测试共用）：

```ts
export function normalizeBase32Secret(raw: string): { ok: true; secret: string } | { ok: false; error: string };
export function buildOtpauthUri(auth: Pick<OtpAuthenticator,
  'type' | 'issuer' | 'label' | 'secret' | 'algorithm' | 'digits' | 'period' | 'counter'>): string;
export function parseOtpauthInput(text: string):   // 手输 secret 或粘贴 otpauth URI
  | { ok: true; auth: Omit<OtpAuthenticator, 'id' | 'label'> & { label?: string } }
  | { ok: false; error: 'hotp' | 'migration' | 'invalid' | 'unsupported-type' };
export function materializeHostTotp(auth: OtpAuthenticator, existing?: HostTotpConfig): HostTotpConfig;
export function clearAuthenticatorReferences(hosts: readonly Host[], authenticatorId: string): Host[];
export function getAuthenticator(authenticators: readonly OtpAuthenticator[], id?: string): OtpAuthenticator | undefined;
```

- URI 形如 `otpauth://totp/JumpServer:prod?secret=...&issuer=JumpServer&algorithm=SHA1&digits=6&period=30`（label 里的 `issuer:label` 与 `issuer` 参数都写，和主进程 `buildOtpauthUri` 保持一致）。
- **防漂移**：新增 `domain/otpAuthenticator.parity.test.ts`，用同一组 fixture 对比 `domain/otpAuthenticator.ts` 与 `domain/totp.shared.cjs` 的 `buildOtpauthUri` / `parseOtpauthUri` 输出（仓库已有 `totpPrompt.shared.cjs` ↔ `.mjs` 的同类先例）。
- 校验/预览统一走现有 IPC：`window.netcatty.previewTotp({ text: builtUri })`（`types/global/netcatty-bridge-files.d.ts:162`），返回 code + secondsRemaining + issuer/label，不新增单条 IPC。
- 管理页需要同时显示多个验证器的倒计时 → 新增**批量**预览 IPC `netcatty:totp:preview-many`（入参 `{ texts: string[] }`，出参逐项结果，主进程内部仍用 `previewTotpText`），避免 N 条/秒的 IPC 风暴。

### 4.4 UI

#### 4.4.1 新增 Vault 分区「验证器」

- `components/VaultView.tsx`：`VaultSection` 联合类型加 `"authenticators"`；`lazy(() => import("./OtpAuthenticatorsManager"))`；section 内容块照 `proxies` 的写法（`:1650` 附近）加一段。
- `components/vault/VaultViewLayout.tsx`：侧栏按钮放在"密钥库"之后（`ShieldCheck` 图标），文案 `vault.nav.authenticators`；折叠态走 Tooltip。
- 新组件 `components/OtpAuthenticatorsManager.tsx`，以 `components/ProxyProfilesManager.tsx` 为模板（AsidePanel + 列表 + 搜索 + 新建/编辑/删除/复制 + 拖动排序可选）：
  - 列表项：名称、issuer/account、`TOTP · SHA1 · 6 位 · 30s` 摘要、**实时验证码 + 倒计时环 + 复制按钮**（内置验证器 app 的核心价值）。
  - 新建/编辑对话框 `components/OtpAuthenticatorDialog.tsx`：名称、issuer、账号、类型（v1 只有 TOTP）、密钥（支持直接粘贴 `otpauth://` URI，或二维码图片 / 截屏扫码复用 `HostTotpFields` 现有逻辑）、算法、位数、时间间隔（15/30/60/自定义）、实时预览、保存。
  - 删除：若被 N 台主机引用 → 二次确认文案带台数，确认后 `clearAuthenticatorReferences` 清空这些主机的 `otpAuthenticatorId` 与 `totp`。
  - 空状态、搜索、错误提示（无效密钥 / 不支持的 URI / HOTP 未启用）。

#### 4.4.2 主机设置里选择验证器

`components/HostTotpFields.tsx` 改造（保留组件名与 `flushRef` 契约，测试需同步更新）：

```text
[ShieldCheck] 动态口令 (OTP)
 验证器   [ 不使用 ▾ ]  [新建…] [管理]
         选项 = 不启用 / 现有验证器列表（显示名称 + 6 位码摘要）
 预览     123 456   (28s)
 [Switch] 登录时自动填充
 提示词    [ 正则，可选 ]                     (仅 autoSubmit 开启时显示)
 ▸ 高级：仅此主机的手动密钥（旧版）
```

- 选中验证器：写 `form.otpAuthenticatorId = id`，并把 `materializeHostTotp(auth, form.totp)` 写进 `form.totp`（保存时一并落盘）。
- 选"不使用"：清 `otpAuthenticatorId` 与 `totp`（沿用现有清除确认）。
- 旧版手动密钥保留在可折叠区：已有 `host.totp.uri` 且无 `otpAuthenticatorId` 的主机显示"仅此主机"；提供"另存为验证器"按钮（解析 `host.totp.uri` → 新建验证器 → 回填 `otpAuthenticatorId`）。
- "新建…"按钮：内联打开 `OtpAuthenticatorDialog`，保存成功后自动选中；需要宿主提供 `onCreateOtpAuthenticator`。挂载点有 3 处（`VaultViewLayout`、`AppHostEditorLayer`、`SelectHostPanelContent`）——前两处必须透传；`SelectHostPanelContent` 若拿不到回调，则隐藏"新建…"、只留"管理"提示。
- 协议 telnet/serial 仍隐藏（沿用 `HIDDEN_PROTOCOLS`）。

#### 4.4.3 无渲染进程改动项（明确确认）

- `components/KeyboardInteractiveModal.tsx`：继续消费主进程回传的 `request.totpUri`。
- 7 处 `connectionTotpFields()` 调用点（6 个文件）：不动。
- 跳板机：`sshBridge.cjs:904` 的 `totp: jump.totp` 不动（跳板机是 Host，编辑面板同样能选验证器）。

### 4.5 数据流（选择 → 保存 → 连接）

```text
[验证器管理页] 创建/编辑
      │  updateOtpAuthenticators(list)  → encryptOtpAuthenticators → localStorage
      │  若编辑已有验证器：回写所有 otpAuthenticatorId === id 的主机
      ▼
[主机编辑] 选择验证器
      │  form.otpAuthenticatorId = id
      │  form.totp = { uri: buildOtpauthUri(auth), autoSubmit?, promptPattern? }
      ▼
[保存主机] host.otpAuthenticatorId + host.totp(uri, ...)  落盘（uri 加密）
      ▼
[连接] connectionTotpFields(host).totp → 主进程 sshBridge → sshAuthHelper
      │  键盘交互出现 OTP 提示 → KeyboardInteractiveModal 自动填充/提交
      ▼
[编辑验证器] 重新 materialize 所有引用主机 → 下次连接生效
```

编辑验证器时的级联（放 `useVaultState`）：

```ts
const saveOtpAuthenticator = useCallback(async (next: OtpAuthenticator) => {
  updateOtpAuthenticators(upsert(list, next));
  const affected = hostsRef.current.filter((h) => h.otpAuthenticatorId === next.id);
  if (affected.length === 0) return 0;
  await updateHosts(hostsRef.current.map((h) =>
    h.otpAuthenticatorId === next.id
      ? { ...h, totp: materializeHostTotp(next, h.totp) }
      : h));
  return affected.length;
}, [updateHosts]);
```

> 注意：`updateHosts` 内部会 `sanitize` + 加密，逐台 materialize 后一次性提交，避免 N 次写盘。

### 4.6 删除 / 复制 / 导入时的引用完整性

| 操作 | 行为 |
| --- | --- |
| 删除验证器 | 统计引用数 → 确认 → 从列表移除 + 清空引用主机 `otpAuthenticatorId` / `totp` |
| 复制验证器 | 新 `id`（`label` 加 "副本"），secret 复制 |
| 导入 vault 备份 | `importData` 先写验证器再写主机；主机 URI 已 materialize，不依赖顺序（但顺序仍按 verifier → hosts 执行，减少"引用悬空"窗口） |
| 云同步拉到验证器但无 secret | 条目保留（label/算法/位数/周期），`secret` 缺失；连接时 `connectionTotpFields` 仍用主机 materialized URI，因此**主机照常可用**；只有"新建/编辑验证器"需要重新输入密钥 |
| 主机引用的验证器被同步删掉 | 主机 `otpAuthenticatorId` 悬空 → UI 显示"验证器已删除，仍使用主机内已有密钥"，不阻断连接 |

i18n 新增键（5 语言）：
`vault.nav.authenticators`、`authenticators.*`（title/empty/search/new/edit/delete/duplicate/copyCode/copied/field.*/type.totp/type.hotp/preview/error.*/delete.title/delete.body/delete.referenced/toast.*）、`hostDetails.totp.mode.*`、`hostDetails.totp.select*`。

### 4.7 存储 / 加密 / 同步 / 导入导出清单

| 位置 | 改动 |
| --- | --- |
| `infrastructure/config/storageKeys.ts` | 新增 `STORAGE_KEY_OTP_AUTHENTICATORS = 'netcatty_otp_authenticators_v1'` |
| `domain/models/otpAuthenticator.ts` + `domain/models.ts` | 新实体与导出 |
| `infrastructure/persistence/secureFieldAdapter.ts` | `encryptOtpAuthenticatorSecrets / decryptOtpAuthenticatorSecrets`（只加密 `secret`）+ 数组版 `encrypt/decryptOtpAuthenticators` |
| `application/state/useVaultState.ts` | state、读盘解密、`updateOtpAuthenticators`、storage 事件同步、`exportData` / `importData` / 重置、`saveOtpAuthenticator` / `deleteOtpAuthenticator` |
| `domain/credentials.ts:203` | `stripSyncPayloadEncryptedCredentials` 增加 `otpAuthenticators`：`secret` 为占位符时 `delete secret`（保留条目，避免主机引用悬空） |
| `domain/sync.ts:273,479` | `SyncPayload.otpAuthenticators?: OtpAuthenticator[]`；`SYNC_PAYLOAD_ENTITY_KEYS` 追加 |
| `domain/convergentSync/payload.ts:43` | `CONVERGENT_ENTITY_COLLECTIONS` 追加 `'otpAuthenticators'`（实体 id = `id`；envelope `schemaVersion` 仍为 2，新集合是加法） |
| `application/syncPayload.ts` | build / apply / 三方合并（实体按 id 合并，同其它 vault 实体） |
| `application/app/AppView.tsx` + `app/AppSideEffects.tsx` 等 | 透传 `otpAuthenticators`、`onUpdateOtpAuthenticators`、`onSaveOtpAuthenticator` 到 Vault / 主机编辑 / KeychainExport |
| 导入导出 UI | `ImportVaultDialog` 统计项、`exportData` payload；`KeychainExportPanel` 无需改（URI 已 materialize） |
| i18n | 5 语言 + locale parity 测试 |
| `electron/bridges/totpBridge.cjs` + preload | 新增 `preview-many`（批量预览），单条能力不变 |

### 4.8 迁移与兼容

- 旧主机 `host.totp.uri` 原样可用（`otpAuthenticatorId` 缺省 → 走"仅此主机"分支）。
- 旧数据不需要一次性迁移；提供按需"另存为验证器"。
- 旧版本打开新数据：多出的 `otpAuthenticators` 键被忽略（localStorage 不影响运行），带 `otpAuthenticatorId` 的主机仍带 `totp.uri`，旧版本照常连接（materialize 的额外收益）。
- `GroupConfig.unifiedPassword` 旧版本忽略；密码字段本身已存在，无破坏。

### 4.9 安全注意

- `secret` 只经 `encryptField` 落盘；不进日志、不进 AI 上下文、不经 MCP/CLI vault 接口返回（`electron/bridges/aiBridge/vaultAgentBridge.cjs` 明确不返回密码，新实体不新增暴露）。
- 管理页展示实时验证码是产品需求（内置验证器），文案沿用现有警告："任何能打开此 vault 的人都能看到验证码"。
- 复制验证码走 `navigator.clipboard`，不落地。
- `preview` IPC 继续不回显 `secret`（现有 `totpBridge.test.cjs` 的断言保持），批量预览只返回 code/secondsRemaining。

### 4.10 测试计划

- `domain/otpAuthenticator.test.ts`：base32 归一化、URI 构建/解析、hotp/migration 拒绝、materialize 合并 `autoSubmit`/`promptPattern`、清理引用。
- `domain/otpAuthenticator.parity.test.ts`：与 `domain/totp.shared.cjs` 输出一致。
- `application/state/useVaultState.otpAuthenticators.test.ts`：读写/加密/导出导入、编辑级联回写、删除清理。
- `infrastructure/persistence/secureFieldAdapter.test.ts`：secret 加解密、占位符保留。
- `components/OtpAuthenticatorsManager.test.tsx`：列表、搜索、删除引用确认、复制。
- `components/OtpAuthenticatorDialog.test.tsx`：字段校验、URI 粘贴、预览。
- `components/HostTotpFields.test.tsx`：选择验证器 → `form` 写入 id + uri、旧版折叠区、"另存为验证器"。
- `electron/bridges/totpBridge.test.cjs`：`preview-many` 顺序/错误隔离。
- `application/state/useCloudSync*` / `application/syncPayload.test.ts`：新实体 round-trip、脱敏。
- i18n parity（5 语言）。

### 4.11 若确认要 HOTP

需要额外工作量（约 0.5-1 天）：

1. `domain/totp.shared.cjs` 新增 `generateHotp({ secret, algorithm, digits, counter })`（RFC 4226），`parseOtpauthUri` 放开 `hotp` 并校验 `counter`。
2. 计数器状态：每次连接成功后 `counter + 1` 并持久化（写验证器 + 回写主机 URI）；失败重试不递增。需要明确"多设备/多会话并发"语义（HOTP 天然不适合共享）。
3. UI：类型选 HOTP 时隐藏"时间间隔"、显示当前计数器；管理页显示下一个 counter。
4. `planTotpSubmission` 的"周期剩余 <2s 等待"逻辑对 HOTP 不适用，需分支。

建议 v1 保持 TOTP-only，模型预留字段，后续版本再加。

---

## 5. 实施计划（建议拆 3 个 PR）

| 阶段 | 内容 | 预估 |
| --- | --- | --- |
| P1 | 功能一：模型 + `domain/groupUnifiedPassword.ts` + `useVaultState` 动作 + 3 个触发点 + 分组/主机 UI + i18n + 测试 | 2-3 天 |
| P2 | 功能二：实体 + 加密 + `useVaultState` + 验证器管理页 + 主机选择 UI + 批量预览 IPC + i18n + 测试 | 4-5 天 |
| P3 | 同步/导入导出/CRDT 白名单 + 旧数据"另存为验证器" + 文档 + 回归（`npm test`、`npm run lint`、手动连接演练） | 1-2 天 |

每个阶段独立可运行：P1 不依赖 P2；P2 不改变连接链路（materialize 保证），P3 才把数据带到云同步。

验证方式：
- `npm test`（新增测试文件全部纳入 `node --test` glob；`domain/*.test.ts`、`components/*.test.tsx`、`application/state/*.test.ts` 已在脚本内）。
- `npm run lint`。
- 手动：Mac 上 `npm run dev`，用本地 SSH 靶机验证（1）统一密码传播与跳过（2）堡垒机 OTP 自动填充（3）删除验证器后主机不可用→重新创建后恢复。

---

## 6. 风险与兼容性

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| 统一密码误传播（例如把测试机密码刷到生产） | 中 | 只在显式改密码时传播；开启/首次保存有确认弹窗；toast 报台数；关闭开关不重置 |
| `savePassword === false` 导致"看起来没同步" | 低 | 明确提示跳过台数 |
| 验证器密钥双份（本体 + 主机 URI） | 低 | 同加密层；编辑/删除级联回写；测试覆盖漂移 |
| 云同步不传 secret 导致异机不可用 | 中 | 主机 materialized URI 仍可用；验证器仅编辑时需重录，UI 明示 |
| 新增 sync 实体破坏旧客户端 | 低 | 旧客户端忽略未知字段；`schemaVersion` 不变 |
| 批量导入触发意外传播 | 低 | 设计上 bulk 路径不接传播动作；补测试 |
| `HostTotpFields` 改造影响现有 TOTP 用户 | 中 | 保留旧版折叠区 + 兼容 `host.totp.uri`；现有测试全部保留并扩展 |

---

## 7. 待确认问题（实现前需要拍板）

1. **统一密码是否覆盖子分组**（推荐：覆盖，但"最近开启分组优先"，即子组自己开启后父组不再改它）。若希望"只作用于本层、不含子目录"，算法改为精确匹配 `host.group === manager.path`。
2. **开启开关时是否立即把分组密码刷到现有主机**（推荐：是，保存时二次确认）。若希望"只对之后的新改动生效"，则去掉 `applyGroupUnifiedPassword` 的首次同步。
3. **OTP 类型是否需要 HOTP**（推荐：v1 只做 TOTP，模型预留）。若必须支持，按 4.11 追加。
4. **一台主机是否可能同时选多个验证器**（推荐：v1 单选）。多选会牵涉"填哪个提示词、按顺序尝试"，改动较大。
5. **验证器是否需要在连接成功后自动"续期"**（TOTP 无状态，不需要；此问题仅针对 HOTP 计数器）。

---

## 8. 变更文件清单（实施时对照）

### 功能一

- `domain/models/connection.ts`（GroupConfig 加 `unifiedPassword`）
- `domain/groupUnifiedPassword.ts`（新）
- `domain/groupConfig.ts`（sanitize 保留字段）
- `application/state/useVaultState.ts`（`saveHostWithUnifiedPassword` / `applyGroupUnifiedPassword`）
- `components/GroupSshSettingsSection.tsx`、`components/GroupDetailsPanel.tsx`
- `components/vault/VaultViewLayout.tsx`、`components/VaultView.tsx`、`application/app/AppHostEditorLayer.tsx`
- `application/app/AppHandlers.ts`、`application/app/AppView.tsx`、`application/app/AppSideEffects.tsx`
- `components/HostDetailsPanel.tsx`（徽标/hint）
- i18n 5 语言、测试文件

### 功能二

- `domain/models/otpAuthenticator.ts`（新）、`domain/models.ts`
- `domain/otpAuthenticator.ts`（新）、`domain/otpAuthenticator.parity.test.ts`（新）
- `domain/models/connection.ts`（Host 加 `otpAuthenticatorId`）
- `infrastructure/config/storageKeys.ts`
- `infrastructure/persistence/secureFieldAdapter.ts`
- `application/state/useVaultState.ts`
- `domain/credentials.ts`、`domain/sync.ts`、`domain/convergentSync/payload.ts`
- `application/syncPayload.ts`
- `components/OtpAuthenticatorsManager.tsx`（新）、`components/OtpAuthenticatorDialog.tsx`（新）
- `components/HostTotpFields.tsx`、`components/HostDetailsConnectionSections.tsx`、`components/HostDetailsPanel.tsx`
- `components/VaultView.tsx`、`components/vault/VaultViewLayout.tsx`
- `application/app/AppView.tsx`、`application/app/AppSideEffects.tsx`、`application/app/AppHostEditorLayer.tsx`
- `electron/bridges/totpBridge.cjs`、`electron/preload/api.cjs`、`types/global/netcatty-bridge-files.d.ts`（批量预览）
- i18n 5 语言、测试文件

---

## 附：本地 fork 说明

- 当前目录 `/Users/shx/Documents/deepseek-harness/NetCatty` 是从 `https://github.com/binaricat/Netcatty.git` 克隆的最新 `main`（`d45fb7537`，v1.1.88）。
- `origin` 指向上游；本机没有 `gh` CLI，因此**没有**在 GitHub 上创建个人 fork 远端。改动放在本地分支 `feat/group-unified-password-and-otp-authenticator`。
- 若需要真正的 GitHub fork：安装 `gh` 后执行 `gh repo fork binaricat/Netcatty --remote=true --clone=false`，再把分支 push 到个人 fork。

## 9. 实施记录（2026-10）

### 功能一（已提交 `b194f4ebb`）

- 实际域模块为 `domain/unifiedPassword.ts`（本文早期草案写作 `groupUnifiedPassword.ts`），导出 `resolveUnifiedPasswordScope` / `planUnifiedPasswordForScope` / `collectUnifiedPasswordSubtreeHosts` / `listUnifiedPasswordDonorHosts` / `countUnifiedPasswordTargets`。
- `GroupConfig.unifiedPassword` 默认缺省即关闭；`sanitizeGroupConfig` 仅在值为 `true` 时保留。
- 传播入口收敛为两处：`VaultView.handleSaveGroupConfig` 的第 4 个参数（来源主机 id）与主机侧密码变更（`VaultViewLayout` 主机会话、`AppHandlers` 键盘交互保存密码）。批量导入 / 云同步不触发传播。
- 覆盖子分组、最近启用层生效、`savePassword === false` 的主机跳过；重命名分组时按旧路径传播。

### 功能二（TOTP only）

- 实体：`OtpAuthenticator`（`domain/models/connection.ts`）+ 存储键 `netcatty_otp_authenticators_v1`；密钥随 `secureFieldAdapter` 加密落盘，同步时按 `enc:v1:` 占位剥离。
- 域模块：`domain/otpAuthenticator.ts`（校验、`otpauth://` 互转、materialize、引用计数、重算/清理）。
- materialize 方案：选中验证器后把密钥/算法/位数/周期写进 `host.totp.uri`，并记录 `host.otpAuthenticatorId`；连接链路（会话启动、SFTP、端口转发、键盘交互）无需改动。
- UI：Vault 新增 `authenticators` 分区（`components/OtpAuthenticatorsManager.tsx`）+ 主机 OTP 设置中的"验证器来源"下拉（手动密钥 / 已保存验证器）。
- 同步：`SyncPayload.otpAuthenticators`、实体键列表、三路合并（按 id）、备份导入导出、云端冲突标签、5 种语言文案均已接入。
- 未做：HOTP（类型字段保留，UI 不提供）、一台主机多个验证器、主机页内直接新建验证器（可跳转 Vault 分区创建）。

### 验证

- 定向测试：`domain/otpAuthenticator.test.ts`(11)、`components/OtpAuthenticatorsManager.test.tsx`(2)、`application/i18n/locales/otpAuthenticatorLocales.test.ts`(2)、`domain/syncMerge.test.ts` 新增 2 条合并用例，全过。
- `npx tsc --noEmit`：无本次新增类型错误（仓库基线仍有 773 条既有错误）。
- 全量 `npm test`：15200 tests / 15126 pass / 2 fail；两个失败（`TerminalLayerSupport.dragCleanup.test.ts` 的 Node loader 报错、`sftpBridge.singleChannelDial` 的 fresh-login 计数）在 `v1.1.88` 基线 worktree 上可复现，属环境/既有问题。
