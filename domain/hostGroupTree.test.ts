import { describe, expect, it } from 'vitest';

import { buildHostGroupTree } from './hostGroupTree';
import type { Host } from '../types';

const host = (id: string, label: string, group?: string): Host => ({
  id,
  label,
  hostname: `${id}.example.com`,
  username: 'root',
  port: 22,
  group,
  tags: [],
});

describe('buildHostGroupTree', () => {
  it('groups hosts and keeps ungrouped hosts separate', () => {
    const { groupTree, ungroupedHosts } = buildHostGroupTree(
      [
        host('1', 'web-1', 'prod/web'),
        host('2', 'db-1', 'prod/db'),
        host('3', 'local'),
      ],
      ['prod/web'],
    );

    expect(groupTree).toHaveLength(1);
    expect(groupTree[0].name).toBe('prod');
    expect(ungroupedHosts).toHaveLength(1);
    expect(ungroupedHosts[0].id).toBe('3');
  });
});
