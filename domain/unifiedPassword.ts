import type { GroupConfig, Host } from './models';

/**
 * Group-level "unified password" (统一密码).
 *
 * When a group opts in (`unifiedPassword === true`), the password saved for
 * any host inside that group (or one of its subgroups) is treated as the
 * password for every host the group owns. The nearest opted-in ancestor wins,
 * so enabling the flag on `A/B` never rewrites hosts owned by `A/B/C`.
 *
 * Pure helpers only — persistence lives in the vault state hook.
 */

export const hostGroupPath = (host: Pick<Host, 'group'>): string => (host.group ?? '').trim();

/** True when `groupPath` is `root` itself or nested below it. Empty root matches every host. */
export const hostInGroupSubtree = (host: Pick<Host, 'group'>, root: string): boolean => {
  if (!root) return true;
  const group = hostGroupPath(host);
  return group === root || group.startsWith(`${root}/`);
};

/** Ancestor paths of a group, deepest first: `A/B/C` → `["A/B/C", "A/B", "A"]`. */
export const groupAncestorPaths = (groupPath: string): string[] => {
  const parts = (groupPath ?? '').split('/').filter(Boolean);
  const ancestors: string[] = [];
  for (let length = parts.length; length > 0; length -= 1) {
    ancestors.push(parts.slice(0, length).join('/'));
  }
  return ancestors;
};

/**
 * Hosts whose saved password is the SSH-style login password. Telnet, serial,
 * local shells and plugin protocols have their own credential models and must
 * never be rewritten by the unified-password feature.
 */
export const isUnifiedPasswordCapableHost = (host: Pick<Host, 'protocol'>): boolean => {
  const protocol = host.protocol ?? 'ssh';
  if (protocol === 'telnet' || protocol === 'serial' || protocol === 'local') return false;
  return !protocol.startsWith('plugin:');
};

export interface UnifiedPasswordScope {
  groupPath: string;
  config: GroupConfig;
}

/**
 * Nearest opted-in ancestor group for a host, or null when no ancestor group
 * enables unified passwords.
 */
export const resolveUnifiedPasswordScope = (
  host: Pick<Host, 'group'>,
  groupConfigs: readonly GroupConfig[],
): UnifiedPasswordScope | null => {
  const group = hostGroupPath(host);
  if (!group) return null;
  const byPath = new Map(groupConfigs.map((config) => [config.path, config]));
  for (const ancestor of groupAncestorPaths(group)) {
    const config = byPath.get(ancestor);
    if (config?.unifiedPassword === true) return { groupPath: ancestor, config };
  }
  return null;
};

/** Hosts that a group's unified password would own, ignoring deeper opted-in groups. */
export const collectUnifiedPasswordSubtreeHosts = (
  hosts: readonly Host[],
  groupPath: string,
): Host[] => hosts.filter((host) => hostInGroupSubtree(host, groupPath));

export interface UnifiedPasswordUpdatePlan {
  /** Opted-in group that owns the write, or null when nothing was applied. */
  scopePath: string | null;
  /** Full host list, preserving object identity for untouched hosts. */
  hosts: Host[];
  changedHostIds: string[];
  skippedHostIds: string[];
  /** Updated owning group config (with the new default password), when applicable. */
  groupConfig: GroupConfig | null;
}

export interface PlanUnifiedPasswordForScopeInput {
  hosts: readonly Host[];
  groupConfigs: readonly GroupConfig[];
  /** Group whose unified password should be (re)applied. */
  scopePath: string;
  password: string;
  /** Also store the password on the group config so new hosts inherit it. */
  updateGroupDefault?: boolean;
}

const withSavedPassword = (host: Host, password: string): Host => {
  if (host.password === password && host.savePassword !== false) return host;
  return { ...host, password, savePassword: true };
};

/**
 * Apply `password` to every host owned by `scopePath`.
 *
 * Ownership rules:
 * - only hosts inside the subtree are touched;
 * - a nearer opted-in group owns its hosts, so deeper enabled groups are skipped;
 * - hosts that explicitly opt out of saving passwords (`savePassword === false`)
 *   are skipped instead of silently flipping the user's choice;
 * - telnet / serial / local / plugin hosts are never touched.
 */
export function planUnifiedPasswordForScope(
  input: PlanUnifiedPasswordForScopeInput,
): UnifiedPasswordUpdatePlan {
  const { hosts, groupConfigs, scopePath, password, updateGroupDefault = true } = input;
  const scopeConfig = groupConfigs.find((config) => config.path === scopePath);
  if (!scopeConfig || scopeConfig.unifiedPassword !== true || !password) {
    return {
      scopePath: null,
      hosts: [...hosts],
      changedHostIds: [],
      skippedHostIds: [],
      groupConfig: null,
    };
  }

  const changedHostIds: string[] = [];
  const skippedHostIds: string[] = [];
  const nextHosts = hosts.map((host) => {
    if (!hostInGroupSubtree(host, scopePath)) return host;
    if (resolveUnifiedPasswordScope(host, groupConfigs)?.groupPath !== scopePath) return host;
    if (!isUnifiedPasswordCapableHost(host)) return host;
    if (host.savePassword === false) {
      skippedHostIds.push(host.id);
      return host;
    }
    const next = withSavedPassword(host, password);
    if (next !== host) changedHostIds.push(host.id);
    return next;
  });

  return {
    scopePath,
    hosts: nextHosts,
    changedHostIds,
    skippedHostIds,
    groupConfig: updateGroupDefault
      ? { ...scopeConfig, password, savePassword: true }
      : scopeConfig,
  };
}

/**
 * Password donors for the "enable unified password" picker: hosts inside the
 * subtree that currently have a usable saved password.
 */
export const listUnifiedPasswordDonorHosts = (
  hosts: readonly Host[],
  groupPath: string,
): Host[] => collectUnifiedPasswordSubtreeHosts(hosts, groupPath)
  .filter((host) => isUnifiedPasswordCapableHost(host)
    && host.savePassword !== false
    && typeof host.password === 'string'
    && host.password.length > 0)
  .sort((a, b) => a.label.localeCompare(b.label));

/** Count of hosts a group would take over if unified passwords were enabled now. */
export const countUnifiedPasswordTargets = (
  hosts: readonly Host[],
  groupConfigs: readonly GroupConfig[],
  groupPath: string,
): number => hosts.filter((host) => {
  if (!hostInGroupSubtree(host, groupPath)) return false;
  if (!isUnifiedPasswordCapableHost(host)) return false;
  return resolveUnifiedPasswordScope(host, groupConfigs) === null
    || resolveUnifiedPasswordScope(host, groupConfigs)!.groupPath === groupPath;
}).length;
