import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSessionAgentIconKey } from './sessionAgentIcon';

test('resolveSessionAgentIconKey detects Claude Code from dynamic title', () => {
  assert.equal(
    resolveSessionAgentIconKey({ dynamicTitle: '✳ Claude Code · refactor auth' }),
    'claude',
  );
});

test('resolveSessionAgentIconKey detects Codex from dynamic title', () => {
  assert.equal(
    resolveSessionAgentIconKey({ dynamicTitle: '⠋ codex · my-project' }),
    'openai',
  );
});

test('resolveSessionAgentIconKey detects OpenCode and Droid from launch commands', () => {
  assert.equal(
    resolveSessionAgentIconKey({ startupCommand: 'opencode' }),
    'opencode',
  );
  assert.equal(
    resolveSessionAgentIconKey({ startupCommand: 'droid' }),
    'droid',
  );
});

test('resolveSessionAgentIconKey ignores dynamic title when host disables it', () => {
  assert.equal(
    resolveSessionAgentIconKey(
      { dynamicTitle: 'Claude Code' },
      { disableDynamicTabTitle: true },
    ),
    null,
  );
});

test('resolveSessionAgentIconKey ignores dynamic title for renamed sessions', () => {
  assert.equal(
    resolveSessionAgentIconKey({
      customName: 'Prod deploy',
      dynamicTitle: 'Claude Code',
    }),
    null,
  );
});

test('resolveSessionAgentIconKey falls back to host startup command', () => {
  assert.equal(
    resolveSessionAgentIconKey({}, { startupCommand: 'codex' }),
    'openai',
  );
});
