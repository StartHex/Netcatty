/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { memo } from 'react';

import { TerminalFocusSidebar } from './TerminalFocusSidebar';
import { terminalLayerFocusSidebarPropsEqual } from './terminalLayerViewMemo';

type FocusSidebarContext = Record<string, any>;

function TerminalLayerFocusSidebarSectionInner({ ctx }: { ctx: FocusSidebarContext }) {
  if (!ctx.isFocusMode || !ctx.activeWorkspace) return null;

  return (
    <TerminalFocusSidebar
      activeWorkspace={ctx.activeWorkspace}
      focusedSessionId={ctx.focusedSessionId}
      onReorderWorkspaceSessions={ctx.onReorderWorkspaceSessions}
      onRequestAddToWorkspace={ctx.onRequestAddToWorkspace}
      onSetWorkspaceFocusedSession={ctx.onSetWorkspaceFocusedSession}
      onToggleWorkspaceViewMode={ctx.onToggleWorkspaceViewMode}
      onStartSessionRename={ctx.onStartSessionRename}
      onSubmitSessionRename={ctx.onSubmitSessionRename}
      onCancelSessionRename={ctx.onCancelSessionRename}
      renamingSessionId={ctx.renamingSessionId}
      sessionRenameValue={ctx.sessionRenameValue}
      setSessionRenameValue={ctx.setSessionRenameValue}
      resolvedPreviewTheme={ctx.resolvedPreviewTheme}
      sessionHostsMap={ctx.sessionHostsMap}
      sessions={ctx.sessions}
      t={ctx.t}
    />
  );
}

export const TerminalLayerFocusSidebarSection = memo(
  TerminalLayerFocusSidebarSectionInner,
  (prev, next) => terminalLayerFocusSidebarPropsEqual(prev.ctx, next.ctx),
);
TerminalLayerFocusSidebarSection.displayName = 'TerminalLayerFocusSidebarSection';
