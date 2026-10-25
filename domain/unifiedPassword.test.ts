import test from "node:test";
import assert from "node:assert/strict";
import {
  collectUnifiedPasswordSubtreeHosts,
  countUnifiedPasswordTargets,
  groupAncestorPaths,
  hostInGroupSubtree,
  isUnifiedPasswordCapableHost,
  listUnifiedPasswordDonorHosts,
  planUnifiedPasswordForScope,
  resolveUnifiedPasswordScope,
} from "./unifiedPassword.ts";
import type { GroupConfig, Host } from "./models.ts";

const host = (overrides: Partial<Host> = {}): Host => ({
  id: "host-1",
  label: "Host",
  hostname: "example.com",
  username: "root",
  tags: [],
  os: "linux",
  group: "A",
  ...overrides,
});

const group = (overrides: Partial<GroupConfig> = {}): GroupConfig => ({
  path: "A",
  ...overrides,
});

test("hostInGroupSubtree respects path boundaries", () => {
  assert.equal(hostInGroupSubtree(host({ group: "A" }), "A"), true);
  assert.equal(hostInGroupSubtree(host({ group: "A/B" }), "A"), true);
  assert.equal(hostInGroupSubtree(host({ group: "A/BC" }), "A"), true);
  assert.equal(hostInGroupSubtree(host({ group: "AB" }), "A"), false);
  assert.equal(hostInGroupSubtree(host({ group: "A/BC" }), "A/B"), false);
  assert.equal(hostInGroupSubtree(host({ group: "A" }), "A/B"), false);
  assert.equal(hostInGroupSubtree(host({ group: "" }), "A"), false);
});

test("groupAncestorPaths lists deepest group first", () => {
  assert.deepEqual(groupAncestorPaths("A/B/C"), ["A/B/C", "A/B", "A"]);
  assert.deepEqual(groupAncestorPaths("A"), ["A"]);
  assert.deepEqual(groupAncestorPaths(""), []);
});

test("telnet, serial, local and plugin hosts are not password targets", () => {
  assert.equal(isUnifiedPasswordCapableHost(host()), true);
  assert.equal(isUnifiedPasswordCapableHost(host({ protocol: "mosh" })), true);
  assert.equal(isUnifiedPasswordCapableHost(host({ protocol: "telnet" })), false);
  assert.equal(isUnifiedPasswordCapableHost(host({ protocol: "serial" })), false);
  assert.equal(isUnifiedPasswordCapableHost(host({ protocol: "local" })), false);
  assert.equal(isUnifiedPasswordCapableHost(host({ protocol: "plugin:jadx" })), false);
});

test("resolveUnifiedPasswordScope prefers the nearest opted-in group", () => {
  const configs = [
    group({ path: "A", unifiedPassword: true, password: "outer" }),
    group({ path: "A/B", unifiedPassword: true, password: "inner" }),
    group({ path: "A/C" }),
  ];

  assert.equal(resolveUnifiedPasswordScope(host({ group: "A" }), configs)?.groupPath, "A");
  assert.equal(resolveUnifiedPasswordScope(host({ group: "A/B" }), configs)?.groupPath, "A/B");
  assert.equal(resolveUnifiedPasswordScope(host({ group: "A/B/D" }), configs)?.groupPath, "A/B");
  assert.equal(resolveUnifiedPasswordScope(host({ group: "A/C" }), configs)?.groupPath, "A");
  assert.equal(resolveUnifiedPasswordScope(host({ group: "A/Unknown" }), configs)?.groupPath, "A");
  assert.equal(resolveUnifiedPasswordScope(host({ group: "" }), configs), null);
});

test("planUnifiedPasswordForScope rewrites the owned subtree only", () => {
  const hosts = [
    host({ id: "a-1", group: "A", password: "old", savePassword: true }),
    host({ id: "a-sub", group: "A/B", password: "old", savePassword: true }),
    host({ id: "b-1", group: "A/B/C", password: "old" }),
    host({ id: "other", group: "Other", password: "old" }),
  ];
  const configs = [group({ path: "A", unifiedPassword: true })];

  const plan = planUnifiedPasswordForScope({
    hosts,
    groupConfigs: configs,
    scopePath: "A",
    password: "new",
  });

  assert.equal(plan.scopePath, "A");
  assert.deepEqual(plan.changedHostIds, ["a-1", "a-sub", "b-1"]);
  assert.equal(plan.hosts.find((h) => h.id === "a-1")?.password, "new");
  assert.equal(plan.hosts.find((h) => h.id === "b-1")?.password, "new");
  assert.equal(plan.hosts.find((h) => h.id === "other")?.password, "old");
  assert.equal(plan.groupConfig?.password, "new");
});

test("deeper opted-in groups keep ownership of their hosts", () => {
  const hosts = [
    host({ id: "a-1", group: "A", password: "old" }),
    host({ id: "ab-1", group: "A/B", password: "keep-me" }),
  ];
  const configs = [
    group({ path: "A", unifiedPassword: true }),
    group({ path: "A/B", unifiedPassword: true }),
  ];

  const plan = planUnifiedPasswordForScope({
    hosts,
    groupConfigs: configs,
    scopePath: "A",
    password: "new",
  });

  assert.deepEqual(plan.changedHostIds, ["a-1"]);
  assert.equal(plan.hosts.find((h) => h.id === "ab-1")?.password, "keep-me");
});

test("hosts that opt out of saving passwords are skipped and reported", () => {
  const hosts = [
    host({ id: "a-1", group: "A", password: "old", savePassword: true }),
    host({ id: "a-2", group: "A", password: "old", savePassword: false }),
  ];

  const plan = planUnifiedPasswordForScope({
    hosts,
    groupConfigs: [group({ path: "A", unifiedPassword: true })],
    scopePath: "A",
    password: "new",
  });

  assert.deepEqual(plan.changedHostIds, ["a-1"]);
  assert.deepEqual(plan.skippedHostIds, ["a-2"]);
  assert.equal(plan.hosts.find((h) => h.id === "a-2")?.password, "old");
});

test("plan is a no-op when the group is not opted in or the password is empty", () => {
  const hosts = [host({ id: "a-1", group: "A", password: "old" })];

  const disabled = planUnifiedPasswordForScope({
    hosts,
    groupConfigs: [group({ path: "A" })],
    scopePath: "A",
    password: "new",
  });
  assert.equal(disabled.scopePath, null);
  assert.deepEqual(disabled.changedHostIds, []);
  assert.equal(disabled.hosts[0], hosts[0]);

  const empty = planUnifiedPasswordForScope({
    hosts,
    groupConfigs: [group({ path: "A", unifiedPassword: true })],
    scopePath: "A",
    password: "",
  });
  assert.equal(empty.scopePath, null);
  assert.equal(empty.hosts[0], hosts[0]);
});

test("unchanged hosts keep object identity", () => {
  const untouched = host({ id: "other", group: "Other", password: "old" });
  const plan = planUnifiedPasswordForScope({
    hosts: [host({ id: "a-1", group: "A", password: "new" }), untouched],
    groupConfigs: [group({ path: "A", unifiedPassword: true })],
    scopePath: "A",
    password: "new",
  });

  assert.equal(plan.changedHostIds.length, 0);
  assert.equal(plan.hosts[1], untouched);
});

test("donor list only exposes hosts with a saved password", () => {
  const hosts = [
    host({ id: "with", group: "A", password: "secret" }),
    host({ id: "without", group: "A" }),
    host({ id: "opted-out", group: "A", password: "secret", savePassword: false }),
    host({ id: "nested", group: "A/B", password: "secret" }),
    host({ id: "telnet", group: "A", protocol: "telnet", password: "secret" }),
  ];

  assert.deepEqual(
    listUnifiedPasswordDonorHosts(hosts, "A").map((h) => h.id),
    ["with", "nested"],
  );
});

test("collectUnifiedPasswordSubtreeHosts and target count ignore foreign hosts", () => {
  const hosts = [
    host({ id: "a-1", group: "A" }),
    host({ id: "a-sub", group: "A/B" }),
    host({ id: "other", group: "Other" }),
  ];

  assert.deepEqual(
    collectUnifiedPasswordSubtreeHosts(hosts, "A").map((h) => h.id),
    ["a-1", "a-sub"],
  );
  assert.equal(countUnifiedPasswordTargets(hosts, [], "A"), 2);
});

test("sanitizeGroupConfig drops non-boolean unifiedPassword values", async () => {
  const { sanitizeGroupConfig } = await import("./groupConfig.ts");
  assert.equal(sanitizeGroupConfig(group({ unifiedPassword: true })).unifiedPassword, true);
  assert.equal("unifiedPassword" in sanitizeGroupConfig(group({ unifiedPassword: false })), false);
  assert.equal(
    "unifiedPassword" in sanitizeGroupConfig({ path: "A", unifiedPassword: "yes" } as unknown as GroupConfig),
    false,
  );
});

test('sanitizeGroupConfig keeps the chosen source host only while unified is on', async () => {
  const { sanitizeGroupConfig } = await import('./groupConfig.ts');
  const enabled = sanitizeGroupConfig({
    path: 'A',
    unifiedPassword: true,
    unifiedPasswordSourceHostId: 'host-1',
    password: 'p',
  });
  assert.equal(enabled.unifiedPassword, true);
  assert.equal(enabled.unifiedPasswordSourceHostId, 'host-1');

  const disabled = sanitizeGroupConfig({
    path: 'A',
    unifiedPasswordSourceHostId: 'host-1',
    password: 'p',
  });
  assert.equal(disabled.unifiedPassword, undefined);
  assert.equal(disabled.unifiedPasswordSourceHostId, undefined);
});
