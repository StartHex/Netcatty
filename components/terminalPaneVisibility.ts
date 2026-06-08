import { activeTabStore } from "../application/state/activeTabStore";
import type { Workspace } from "../types";

export const HIDDEN_TERMINAL_PANE_SNAPSHOT = "hidden";

export type TerminalPaneSnapshot =
  | typeof HIDDEN_TERMINAL_PANE_SNAPSHOT
  | `solo|${string}`
  | `workspace|split|${string}`
  | `workspace|focus|${string}|${string}`;

export type TerminalPaneFocusSnapshot = "na" | "focused" | "unfocused";

interface GetTerminalPaneSnapshotOptions {
  activeTabId: string | null;
  sessionId: string;
  sessionWorkspaceId?: string;
  workspaceById: Map<string, Workspace>;
  isTerminalLayerVisible: boolean;
}

export function getTerminalPaneSnapshot({
  activeTabId,
  sessionId,
  sessionWorkspaceId,
  workspaceById,
  isTerminalLayerVisible,
}: GetTerminalPaneSnapshotOptions): TerminalPaneSnapshot {
  if (!isTerminalLayerVisible || !activeTabId) {
    return HIDDEN_TERMINAL_PANE_SNAPSHOT;
  }

  const activeWorkspace = workspaceById.get(activeTabId);
  if (activeWorkspace) {
    if (sessionWorkspaceId !== activeWorkspace.id) {
      return HIDDEN_TERMINAL_PANE_SNAPSHOT;
    }

    const focusedSessionId = activeWorkspace.focusedSessionId ?? "";
    if (activeWorkspace.viewMode === "focus") {
      return sessionId === focusedSessionId
        ? `workspace|focus|${activeWorkspace.id}|${focusedSessionId}`
        : HIDDEN_TERMINAL_PANE_SNAPSHOT;
    }

    return `workspace|split|${activeWorkspace.id}`;
  }

  return activeTabId === sessionId
    ? `solo|${sessionId}`
    : HIDDEN_TERMINAL_PANE_SNAPSHOT;
}

export function parseTerminalPaneSnapshot(snapshot: TerminalPaneSnapshot): {
  isVisible: boolean;
  mode: "hidden" | "solo" | "split" | "focus";
  workspaceId: string | null;
  focusedSessionId: string | null;
} {
  if (snapshot === HIDDEN_TERMINAL_PANE_SNAPSHOT) {
    return {
      isVisible: false,
      mode: "hidden",
      workspaceId: null,
      focusedSessionId: null,
    };
  }

  const parts = snapshot.split("|");
  if (parts[0] === "solo") {
    return {
      isVisible: true,
      mode: "solo",
      workspaceId: null,
      focusedSessionId: null,
    };
  }

  if (parts[1] === "focus") {
    return {
      isVisible: true,
      mode: "focus",
      workspaceId: parts[2] || null,
      focusedSessionId: parts[3] || null,
    };
  }

  return {
    isVisible: true,
    mode: "split",
    workspaceId: parts[2] || null,
    focusedSessionId: null,
  };
}

export function getTerminalPaneFocusSnapshot({
  sessionId,
  sessionWorkspaceId,
  workspaceById,
}: {
  sessionId: string;
  sessionWorkspaceId?: string;
  workspaceById: Map<string, Workspace>;
}): TerminalPaneFocusSnapshot {
  const activeTabId = activeTabStore.getActiveTabId();
  if (!activeTabId) return "na";

  const activeWorkspace = workspaceById.get(activeTabId);
  if (!activeWorkspace || activeWorkspace.viewMode === "focus") return "na";
  if (sessionWorkspaceId !== activeWorkspace.id) return "na";

  return activeWorkspace.focusedSessionId === sessionId ? "focused" : "unfocused";
}
