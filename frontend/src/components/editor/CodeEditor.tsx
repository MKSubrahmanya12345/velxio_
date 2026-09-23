import Editor, { type Monaco } from '@monaco-editor/react';
import { useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { editor as MonacoEditor } from 'monaco-editor';
import { useEditorStore } from '../../store/useEditorStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { registerRetroAsm, LANGUAGE_ID as RETRO_ASM_ID } from './retroAsmLanguage';
import { attachIntellisenseMonaco } from '../../lib/intellisenseRegistry';
import { CHIP_JSON_SCHEMA, CHIP_JSON_SCHEMA_URI } from './chipJsonSchema';
import { defineVelxioThemes, monacoThemeFor } from './monacoThemes';
import { useResolvedTheme } from '../../hooks/useTheme';
import { registerEditorCommand } from '../../lib/editorCommands';
import {
  hasDocumentFormatter,
  registerCodeFormatters,
  setFormatterMessages,
} from './codeFormatters';
import {
  registerCursorCompletions,
  registerCursorKeybindings,
  registerTabCompletion,
  injectCursorStyles,
  showInlineEdit,
} from './cursorFeatures';

function getLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 's' || ext === 'asm') return RETRO_ASM_ID;
  if (['ino', 'cpp', 'c', 'cc', 'h', 'hpp'].includes(ext)) return 'cpp';
  if (ext === 'py') return 'python';
  if (ext === 'json') return 'json';
  if (ext === 'md') return 'markdown';
  if (ext === 'hex') return 'plaintext';
  return 'plaintext';
}

export const CodeEditor = () => {
  const { files, activeFileId, setFileContent, fontSize, manifestViewBoardId } =
    useEditorStore();
  const boards = useSimulatorStore((s) => s.boards);
  const theme = monacoThemeFor(useResolvedTheme());
  const activeFile = files.find((f) => f.id === activeFileId);
  const language = activeFile ? getLanguage(activeFile.name) : 'cpp';
  const { t } = useTranslation();

  const [instance, setInstance] = useState<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  
  useEffect(() => {
    if (!instance || manifestViewBoardId || !hasDocumentFormatter(language)) return;
    return registerEditorCommand('edit.formatDocument', () => {
      if (!instance.getModel()) return;
      instance.focus();
      void instance.getAction('editor.action.formatDocument')?.run();
    });
  }, [instance, language, manifestViewBoardId]);
  
  useEffect(() => {
    setFormatterMessages({
      failedTitle: () => t('editor.format.failed', 'Could not format the file'),
    });
  }, [t]);

  // Cursor-style global key handlers
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+K already handled by Monaco action, but also support global
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !e.shiftKey) {
        // Let Monaco handle it if editor focused
        const active = document.activeElement;
        if (active?.closest('.monaco-editor')) return;
        e.preventDefault();
        if (instance) showInlineEdit(instance);
      }
      // Cmd+L focus agent
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l' && !e.shiftKey) {
        const active = document.activeElement;
        if (active?.tagName === 'TEXTAREA' && active?.closest('.agent-panel')) return;
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('velxio-cursor-focus-chat', { detail: {} }));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [instance]);

  // Inject cursor styles once
  useEffect(() => {
    injectCursorStyles();
  }, []);

  if (manifestViewBoardId) {
    const b = boards.find((x) => x.id === manifestViewBoardId);
    const content = JSON.stringify({ libraries: b?.libraries ?? [] }, null, 2);
    return (
      <div style={{ height: '100%', width: '100%' }}>
        <Editor
          key="__libraries_json__"
          height="100%"
          language="json"
          theme={theme}
          beforeMount={defineVelxioThemes}
          value={content}
          options={{
            readOnly: true,
            domReadOnly: true,
            minimap: { enabled: false },
            fontSize,
            automaticLayout: true,
            scrollBeyondLastLine: false,
            wordWrap: 'on',
          }}
        />
      </div>
    );
  }

  return (
    <div style={{ height: '100%', width: '100%', position: 'relative' }}>
      {/* Cursor-style status bar */}
      <div style={{
        position: 'absolute',
        top: 0,
        right: 0,
        zIndex: 10,
        display: 'flex',
        gap: '4px',
        padding: '4px 8px',
        fontSize: '10px',
        color: '#888',
        background: 'rgba(0,0,0,0.3)',
        borderRadius: '0 0 0 6px',
      }}>
        <span title="Cmd+K Inline Edit">⌘K</span>
        <span style={{ opacity: 0.3 }}>|</span>
        <span title="Cmd+L Chat">⌘L</span>
        <span style={{ opacity: 0.3 }}>|</span>
        <span title="Cmd+I Composer">⌘I</span>
        <span style={{ opacity: 0.3 }}>|</span>
        <span title="Tab Complete">⇥</span>
        <span style={{ marginLeft: '6px', color: '#007acc' }}>Velxio = Cursor</span>
      </div>
      
      <Editor
        key={activeFileId}
        height="100%"
        language={language}
        theme={theme}
        value={activeFile?.content ?? ''}
        {...(activeFile && activeFile.name.endsWith('chip.json')
          ? { path: `velxio-ws/${useEditorStore.getState().activeGroupId}/${activeFile.name}` }
          : {})}
        beforeMount={(monaco: Monaco) => {
          monacoRef.current = monaco;
          defineVelxioThemes(monaco);
          registerRetroAsm(monaco);
          registerCodeFormatters(monaco);
          attachIntellisenseMonaco(monaco);
          // Cursor completions
          registerCursorCompletions(monaco);
          
          const g = monaco as unknown as { __velxioChipJsonSchema?: boolean };
          if (!g.__velxioChipJsonSchema && monaco.languages.json?.jsonDefaults) {
            g.__velxioChipJsonSchema = true;
            monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
              validate: true,
              schemas: [
                {
                  uri: CHIP_JSON_SCHEMA_URI,
                  fileMatch: ['*chip.json'],
                  schema: CHIP_JSON_SCHEMA,
                },
              ],
            });
          }
        }}
        onMount={(ed) => {
          setInstance(ed);
          if (monacoRef.current) {
            registerCursorKeybindings(monacoRef.current, ed);
            registerTabCompletion(monacoRef.current, ed);
            
            // Focus editor with Cmd+K hint on first mount
            ed.addAction({
              id: 'velxio.cursorHint',
              label: 'Velxio: Show Cursor Hints',
              keybindings: [],
              run: () => {
                // Show hint overlay
                const hint = document.createElement('div');
                hint.style.cssText = `
                  position: absolute;
                  bottom: 20px;
                  left: 50%;
                  transform: translateX(-50%);
                  background: #1e1e1e;
                  border: 1px solid #333;
                  border-radius: 6px;
                  padding: 8px 14px;
                  color: #ccc;
                  font-size: 12px;
                  z-index: 100;
                  display: flex;
                  gap: 12px;
                `;
                hint.innerHTML = `
                  <span><b>⌘K</b> Inline Edit</span>
                  <span><b>⌘L</b> Add to Chat</span>
                  <span><b>⌘I</b> Composer</span>
                  <span><b>Tab</b> Accept</span>
                  <span style="color:#007acc;">Velxio = Cursor</span>
                `;
                ed.getDomNode()?.appendChild(hint);
                setTimeout(() => hint.remove(), 4000);
              }
            });
          }
        }}
        onChange={(value) => {
          if (activeFileId) setFileContent(activeFileId, value || '');
        }}
        options={{
          minimap: { enabled: true },
          fontSize,
          automaticLayout: true,
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          fixedOverflowWidgets: true,
          suggest: { snippetsPreventQuickSuggestions: false },
          // Cursor-like settings
          quickSuggestions: {
            other: true,
            comments: true,
            strings: true,
          },
          suggestOnTriggerCharacters: true,
          acceptSuggestionOnEnter: 'on',
          tabCompletion: 'on',
          wordBasedSuggestions: 'allDocuments',
          // Smooth editing
          cursorBlinking: 'smooth',
          cursorSmoothCaretAnimation: 'on',
          smoothScrolling: true,
          // Inline suggest (ghost text) - Cursor Tab
          inlineSuggest: {
            enabled: true,
          },
        }}
      />
    </div>
  );
};
