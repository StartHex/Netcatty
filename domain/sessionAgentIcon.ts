import {
  isRecognizedAgentIconKey,
  resolveAgentIconKey,
  type AgentIconKey,
} from './agentIcon';
import type { Host, TerminalSession } from '../types';
import { isDynamicTabTitleDisabled } from './sessionTabTitle';

export type SessionAgentIconSource = Pick<
  TerminalSession,
  'dynamicTitle' | 'startupCommand' | 'customName' | 'hostLabel' | 'localShell' | 'localShellName'
> & {
  hostStartupCommand?: Host['startupCommand'];
};

/**
 * Infer a coding-agent icon from OSC tab titles and launch commands.
 * Mirrors freshell's per-pane provider icons, but uses title/command heuristics
 * because Netcatty sessions are usually generic SSH shells.
 */
export function resolveSessionAgentIconKey(
  source: SessionAgentIconSource,
  host?: Pick<Host, 'disableDynamicTabTitle' | 'startupCommand'>,
): AgentIconKey | null {
  const candidates: string[] = [];

  if (!isDynamicTabTitleDisabled(host) && !source.customName) {
    const dynamicTitle = source.dynamicTitle?.trim();
    if (dynamicTitle) {
      candidates.push(dynamicTitle);
    }
  }

  if (source.startupCommand) {
    candidates.push(source.startupCommand);
  }
  if (host?.startupCommand) {
    candidates.push(host.startupCommand);
  }
  if (source.localShell) {
    candidates.push(source.localShell);
  }
  if (source.localShellName) {
    candidates.push(source.localShellName);
  }

  for (const candidate of candidates) {
    const key = resolveAgentIconKey({ command: candidate, name: candidate });
    if (isRecognizedAgentIconKey(key)) {
      return key;
    }
  }

  return null;
}
