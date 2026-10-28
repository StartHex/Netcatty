import Editor, { loader, type Monaco, type OnMount, useMonaco } from '@monaco-editor/react';
import { Loader2 } from 'lucide-react';
import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useClipboardBackend } from '@/application/state/useClipboardBackend';
import {
  buildMonacoPasteEdits,
  pasteForMonacoEditorCommand,
  readClipboardTextWithFallbacks,
} from '@/infrastructure/monaco/monacoClipboardPaste';
import { registerSqlMonacoCompletionProvider, type SqlCompletionSource } from '@/infrastructure/monaco/sqlMonacoCompletion';
import { useNetcattyMonacoTheme } from '@/infrastructure/monaco/useNetcattyMonacoTheme';
import { registerNctMonacoCompletionProvider } from '@/infrastructure/scripts/nctMonacoCompletion.ts';

const viteEnv = import.meta.env ?? { BASE_URL: '/' };
const monacoBasePath = viteEnv.DEV
  ? './node_modules/monaco-editor/min/vs'
  : `${viteEnv.BASE_URL}monaco/vs`;
loader.config({ paths: { vs: monacoBasePath } });

export interface ScriptCodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language: 'javascript' | 'python' | 'shell' | 'sql';
  /** Fill parent flex container (modal). Parent must have explicit height. */
  fill?: boolean;
  /** Fixed pixel height (sidebar). Ignored when fill is true. */
  height?: number;
  minimap?: boolean;
  /** Re-layout when container becomes visible (e.g. dialog open). */
  active?: boolean;
  /** Move keyboard focus into the editor after it mounts. */
  autoFocus?: boolean;
  /** Accessible name announced by screen readers. */
  ariaLabel?: string;
  /** Hint shown while the editor is empty. */
  placeholder?: string;
  /** Let Tab move to the next control instead of inserting indentation. */
  tabFocusMode?: boolean;
  /** Run the surrounding form's submit action for Cmd/Ctrl+Enter. */
  onSubmitShortcut?: () => void;
  /** Schema-aware suggestions for the `sql` language (tables, columns, keywords). */
  sqlCompletion?: SqlCompletionSource;
}

export interface ScriptCodeEditorHandle {
  focus: () => void;
  /** Return the selected text, or an empty string when nothing is selected. */
  getSelectionText: () => string;
  /** Full document text, used to resolve the statement around the caret. */
  getValue: () => string;
  /** 1-based line the caret sits on; 1 when the editor is not ready. */
  getCursorLine: () => number;
  /** Text of the caret line, used as a fallback when splitting finds nothing. */
  getCursorLineText: () => string;
}

export const ScriptCodeEditor = React.forwardRef<ScriptCodeEditorHandle, ScriptCodeEditorProps>(({
  value,
  onChange,
  language,
  fill = false,
  height = 240,
  minimap = false,
  active = true,
  autoFocus = false,
  ariaLabel,
  placeholder,
  tabFocusMode = false,
  onSubmitShortcut,
  sqlCompletion,
}, forwardedRef) => {
  const monaco = useMonaco();
  const themeName = useNetcattyMonacoTheme(monaco ?? undefined);
  const { readClipboardText: readClipboardTextFromBridge } = useClipboardBackend();
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const completionDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const layoutDisposableRef = useRef<{ dispose: () => void } | null>(null);
  /** X offset where Monaco renders text (gutter width + padding). */
  const [contentLeft, setContentLeft] = useState<number | null>(null);
  const onSubmitShortcutRef = useRef(onSubmitShortcut);
  onSubmitShortcutRef.current = onSubmitShortcut;
  const sqlCompletionRef = useRef(sqlCompletion);
  sqlCompletionRef.current = sqlCompletion;
  const handlePasteRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const readClipboardTextRef = useRef<() => Promise<string | null>>(() => Promise.resolve(null));

  useImperativeHandle(forwardedRef, () => ({
    focus: () => editorRef.current?.focus(),
    getSelectionText: () => {
      const editor = editorRef.current;
      const selection = editor?.getSelection();
      const model = editor?.getModel();
      if (!editor || !selection || !model || selection.isEmpty()) return '';
      return model.getValueInRange(selection);
    },
    getValue: () => editorRef.current?.getModel()?.getValue() ?? '',
    getCursorLine: () => {
      const position = editorRef.current?.getPosition();
      return position?.lineNumber ?? 1;
    },
    getCursorLineText: () => {
      const editor = editorRef.current;
      const model = editor?.getModel();
      const line = editor?.getPosition()?.lineNumber;
      if (!model || !line) return '';
      return model.getLineContent(line);
    },
  }), []);

  useEffect(() => () => {
    completionDisposableRef.current?.dispose();
    completionDisposableRef.current = null;
    layoutDisposableRef.current?.dispose();
    layoutDisposableRef.current = null;
  }, []);

  useEffect(() => {
    if (!active || !editorRef.current) return;
    const frame = requestAnimationFrame(() => {
      editorRef.current?.layout();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, fill, height]);

  const readClipboardText = useCallback(async (): Promise<string | null> => (
    readClipboardTextWithFallbacks({
      readNavigator: navigator.clipboard?.readText
        ? () => navigator.clipboard.readText()
        : undefined,
      readBridge: readClipboardTextFromBridge,
    })
  ), [readClipboardTextFromBridge]);

  useEffect(() => {
    readClipboardTextRef.current = readClipboardText;
  }, [readClipboardText]);

  const handlePaste = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor) return;

    const text = await readClipboardText();

    if (text === null) {
      // Clipboard read unavailable; fall back to Monaco's native paste.
      editor.trigger('keyboard', 'editor.action.clipboardPasteAction', null);
      return;
    }
    if (!text) return;

    const selections = editor.getSelections();
    if (!selections || selections.length === 0) return;

    editor.executeEdits('netcatty-paste', buildMonacoPasteEdits(text, selections));
    editor.focus();
  }, [readClipboardText]);

  useEffect(() => {
    handlePasteRef.current = handlePaste;
  }, [handlePaste]);

  const handleMount: OnMount = useCallback((editor, monacoInstance) => {
    editorRef.current = editor;
    completionDisposableRef.current?.dispose();
    completionDisposableRef.current = language === 'javascript'
      ? registerNctMonacoCompletionProvider(monacoInstance)
      : language === 'sql'
        ? registerSqlMonacoCompletionProvider(monacoInstance, () => sqlCompletionRef.current?.() ?? [])
        : null;
    if (onSubmitShortcut) {
      editor.addCommand(
        monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.Enter,
        () => onSubmitShortcutRef.current?.(),
      );
    }
    // Fallback paste path for Electron where Monaco clipboardPasteAction can fail.
    // When focus is in the find/replace widget, paste into that input instead of the body.
    editor.addCommand(
      monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyV,
      () => {
        void pasteForMonacoEditorCommand({
          activeElement: document.activeElement,
          readClipboardText: () => readClipboardTextRef.current(),
          pasteIntoEditor: () => handlePasteRef.current(),
        });
      },
    );
    // Track the content origin so the placeholder sits exactly where text starts,
    // whatever the line-number gutter width turns out to be.
    const syncContentLeft = () => setContentLeft(editor.getLayoutInfo().contentLeft);
    syncContentLeft();
    layoutDisposableRef.current?.dispose();
    layoutDisposableRef.current = editor.onDidLayoutChange(syncContentLeft);
    requestAnimationFrame(() => {
      editor.layout();
      syncContentLeft();
    });
    if (autoFocus) editor.focus();
  }, [autoFocus, language, onSubmitShortcut]);

  const editorHeight = fill ? '100%' : `${height}px`;

  return (
    <div className={fill ? 'h-full min-h-0 relative' : 'relative'} style={fill ? undefined : { height }}>
      <Editor
        height={editorHeight}
        language={language}
        value={value}
        onChange={(next) => onChange(next ?? '')}
        onMount={handleMount}
        theme={themeName}
        loading={(
          <div className="absolute inset-0 flex items-center justify-center bg-background">
            <Loader2 size={24} className="animate-spin text-muted-foreground" />
          </div>
        )}
        options={{
          // Prefer native context menu in Electron so right-click Paste uses OS clipboard path.
          contextmenu: false,
          minimap: { enabled: minimap },
          fontSize: 13,
          lineNumbers: 'on',
          wordWrap: 'on',
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
          insertSpaces: true,
          folding: true,
          renderLineHighlight: 'line',
          padding: { top: 8, bottom: 8 },
          bracketPairColorization: { enabled: true },
          ariaLabel,
          tabFocusMode,
        }}
      />
      {placeholder && !value ? (
        <span
          aria-hidden
          className="pointer-events-none absolute z-10 font-mono text-[13px] leading-[19px] text-muted-foreground"
          style={{ left: contentLeft ?? 52, top: 8 }}
        >
          {placeholder}
        </span>
      ) : null}
    </div>
  );
});

ScriptCodeEditor.displayName = 'ScriptCodeEditor';
