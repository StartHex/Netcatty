/* eslint-disable @typescript-eslint/no-explicit-any */

type Ctx = Record<string, any>;

function eq(prev: Ctx, next: Ctx, key: string): boolean {
  return prev[key] === next[key];
}

function eqAll(prev: Ctx, next: Ctx, keys: string[]): boolean {
  for (const key of keys) {
    if (prev[key] !== next[key]) return false;
  }
  return true;
}

const SIDE_PANEL_CTX_KEYS = [
  'isSidePanelOpenForCurrentTab',
  'mountedSftpTabIds',
  'mountedAiTabIds',
  'scriptsMountedTabIds',
  'themeMountedTabIds',
  'sidePanelWidth',
  'sidePanelPosition',
  'activeSidePanelTab',
  'activeTabId',
  'resolvedPreviewTheme',
  'sftpActiveHost',
  'sftpHostForTab',
  'activeTerminalSessionIdForSftp',
  'activeWorkspace',
  'effectiveHosts',
  'hosts',
  'keys',
  'identities',
  'updateHosts',
  'sftpDefaultViewMode',
  'sftpInitialLocationForTab',
  'sftpPendingUploadsForTab',
  'sftpDoubleClickBehavior',
  'sftpAutoSync',
  'sftpShowHiddenFiles',
  'sftpUseCompressedUpload',
  'hotkeyScheme',
  'keyBindings',
  'editorWordWrap',
  'setEditorWordWrap',
  'getTerminalCwd',
  'refocusActiveTerminalSession',
  'terminalSettings',
  'snippets',
  'snippetPackages',
  'handleSnippetFromPanel',
  'followAppTerminalTheme',
  'previewedOrVisibleThemeId',
  'terminalTheme',
  'terminalFontFamilyId',
  'focusedFontFamilyId',
  'focusedFontFamilyOverridden',
  'focusedFontSize',
  'focusedFontSizeOverridden',
  'focusedFontWeight',
  'focusedFontWeightOverridden',
  'focusedThemeOverridden',
  'handleThemeChangeForFocusedSession',
  'handleThemeResetForFocusedSession',
  'handleFontFamilyChangeForFocusedSession',
  'handleFontFamilyResetForFocusedSession',
  'handleFontSizeChangeForFocusedSession',
  'handleFontSizeResetForFocusedSession',
  'handleFontWeightChangeForFocusedSession',
  'handleFontWeightResetForFocusedSession',
  'aiContextsByTabId',
  'resolveAIExecutorContext',
  'pendingTerminalSelectionForAI',
  'handlePendingTerminalSelectionConsumed',
  'setSidePanelWidth',
  'persistSidePanelWidth',
  'handleToggleSftpFromBar',
  'handleOpenScripts',
  'handleOpenTheme',
  'handleOpenAI',
  'handleCloseSidePanel',
  'setSidePanelPosition',
  'handleSftpInitialLocationApplied',
  'handlePendingUploadHandled',
  't',
] as const;

const WORKSPACE_CTX_KEYS = [
  'workspaceInnerRef',
  'workspaceOverlayRef',
  'draggingSessionId',
  'isFocusMode',
  'dropHint',
  'setDropHint',
  'computeSplitHint',
  'handleWorkspaceDrop',
  'sessions',
  'sessionHostsMap',
  'sessionChainHostsMap',
  'sessionSudoAutofillPasswordsMap',
  'workspaceById',
  'workspaceRectsById',
  'isTerminalLayerVisible',
  'workspaceFocusHandlersRef',
  'workspaceBroadcastHandlersRef',
  'splitHorizontalHandlersRef',
  'splitVerticalHandlersRef',
  'themePreview',
  'keys',
  'identities',
  'snippets',
  'knownHosts',
  'terminalFontFamilyId',
  'fontSize',
  'terminalTheme',
  'followAppTerminalTheme',
  'accentMode',
  'customAccent',
  'terminalSettings',
  'hotkeyScheme',
  'keyBindings',
  'resizing',
  'isComposeBarOpen',
  'sessionLogConfig',
  'sshDebugLogsEnabled',
  'onHotkeyAction',
  'handleTerminalFontSizeChange',
  'handleOpenSftp',
  'handleTerminalCwdChange',
  'handleOpenScripts',
  'handleOpenTheme',
  'handleCloseSession',
  'handleStatusChange',
  'handleSessionExit',
  'handleTerminalDataCapture',
  'handleOsDetected',
  'handleUpdateHost',
  'handleAddKnownHost',
  'handleCommandExecuted',
  'onSetWorkspaceFocusedSession',
  'onSplitSession',
  'isBroadcastEnabled',
  'handleBroadcastInput',
  'handleToggleWorkspaceComposeBar',
  'handleSnippetExecutorChange',
  'handleAddSelectionToAI',
  'activeResizers',
  'activeWorkspace',
  'findSplitNode',
  'setResizing',
  'Array',
  'cn',
] as const;

export function terminalLayerSidePanelCtxEqual(prev: Ctx, next: Ctx): boolean {
  return eqAll(prev, next, SIDE_PANEL_CTX_KEYS as unknown as string[]);
}

export function terminalLayerWorkspaceCtxEqual(prev: Ctx, next: Ctx): boolean {
  return eqAll(prev, next, WORKSPACE_CTX_KEYS as unknown as string[]);
}

export function terminalLayerHostTreePropsEqual(prev: Ctx, next: Ctx): boolean {
  return eq(prev, next, 'hosts')
    && eq(prev, next, 'customGroups')
    && eq(prev, next, 'resolvedPreviewTheme')
    && eq(prev, next, 'activeHostIdForSidebar')
    && eq(prev, next, 'onConnectToHost')
    && eq(prev, next, 'onCreateLocalTerminal');
}

export function terminalLayerViewCtxEqual(prev: Ctx, next: Ctx): boolean {
  if (prev.isTerminalLayerVisible !== next.isTerminalLayerVisible) return false;
  if (prev.isComposeBarOpen !== next.isComposeBarOpen) return false;
  if (prev.activeWorkspace !== next.activeWorkspace) return false;
  if (prev.focusedSessionId !== next.focusedSessionId) return false;
  if (prev.handleComposeSend !== next.handleComposeSend) return false;
  if (prev.refocusTerminalSession !== next.refocusTerminalSession) return false;
  if (prev.setIsComposeBarOpen !== next.setIsComposeBarOpen) return false;
  if (prev.isBroadcastEnabled !== next.isBroadcastEnabled) return false;
  if (prev.composeBarThemeColors !== next.composeBarThemeColors) return false;
  if (prev.validAIScopeTargetIds !== next.validAIScopeTargetIds) return false;
  if (prev.workspaceOuterRef !== next.workspaceOuterRef) return false;
  return terminalLayerHostTreePropsEqual(prev, next)
    && terminalLayerSidePanelCtxEqual(prev, next)
    && terminalLayerFocusSidebarPropsEqual(prev, next)
    && terminalLayerWorkspaceCtxEqual(prev, next);
}

export function terminalLayerFocusSidebarPropsEqual(prev: Ctx, next: Ctx): boolean {
  if (prev.isFocusMode !== next.isFocusMode) return false;
  if (!prev.isFocusMode) return true;

  const prevWs = prev.activeWorkspace;
  const nextWs = next.activeWorkspace;
  if (Boolean(prevWs) !== Boolean(nextWs)) return false;
  if (prevWs && nextWs) {
    if (prevWs.id !== nextWs.id) return false;
    if (prevWs.viewMode !== nextWs.viewMode) return false;
    if (prevWs.root !== nextWs.root) return false;
    if (prevWs.focusSessionOrder !== nextWs.focusSessionOrder) return false;
  }

  return eq(prev, next, 'focusedSessionId')
    && eq(prev, next, 'resolvedPreviewTheme')
    && eq(prev, next, 'sessionHostsMap')
    && eq(prev, next, 'sessions')
    && eq(prev, next, 't')
    && eq(prev, next, 'onReorderWorkspaceSessions')
    && eq(prev, next, 'onRequestAddToWorkspace')
    && eq(prev, next, 'onSetWorkspaceFocusedSession')
    && eq(prev, next, 'onToggleWorkspaceViewMode');
}
