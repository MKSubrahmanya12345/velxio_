/**
 * Velxio = Cursor: Cursor-like editor features for Monaco
 * Implements:
 * - Cmd+K / Ctrl+K inline edit (quick AI edit)
 * - Cmd+L / Ctrl+L add to chat / focus agent
 * - Cmd+I / Ctrl+I composer (multi-file agent)
 * - Tab autocomplete with Arduino-aware suggestions
 * - @ mentions for files, components, boards
 * - Ghost text, diff accept/reject
 * - Command palette
 */
import type { Monaco } from '@monaco-editor/react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { useEditorStore } from '../../store/useEditorStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import catalogData from '../../agent/catalog.json';

// --- Tab autocomplete: Arduino-aware inline suggestions ---
const ARDUINO_SNIPPETS = [
  { label: 'setup/loop', insert: 'void setup() {\n  ${1:pinMode(LED_BUILTIN, OUTPUT);}\n}\n\nvoid loop() {\n  ${2:// your code}\n}', doc: 'Arduino main structure' },
  { label: 'digitalWrite', insert: 'digitalWrite(${1:pin}, ${2:HIGH});', doc: 'Write HIGH/LOW' },
  { label: 'digitalRead', insert: 'digitalRead(${1:pin})', doc: 'Read pin' },
  { label: 'analogRead', insert: 'analogRead(${1:A0})', doc: 'Read analog' },
  { label: 'analogWrite', insert: 'analogWrite(${1:pin}, ${2:value});', doc: 'PWM output' },
  { label: 'pinMode', insert: 'pinMode(${1:pin}, ${2:OUTPUT});', doc: 'Set pin mode' },
  { label: 'delay', insert: 'delay(${1:1000});', doc: 'Wait ms' },
  { label: 'delayMicroseconds', insert: 'delayMicroseconds(${1:100});', doc: 'Wait us' },
  { label: 'millis', insert: 'millis()', doc: 'Time since start' },
  { label: 'Serial.begin', insert: 'Serial.begin(${1:9600});', doc: 'Start serial' },
  { label: 'Serial.println', insert: 'Serial.println(${1:msg});', doc: 'Print line' },
  { label: 'Serial.print', insert: 'Serial.print(${1:msg});', doc: 'Print' },
  { label: 'for loop', insert: 'for (int ${1:i}=0; ${1:i}<${2:10}; ${1:i}++) {\n  ${3}\n}', doc: 'For loop' },
  { label: 'if', insert: 'if (${1:condition}) {\n  ${2}\n}', doc: 'If statement' },
  { label: 'Servo', insert: '#include <Servo.h>\nServo ${1:myServo};\n${1:myServo}.attach(${2:9});\n${1:myServo}.write(${3:90});', doc: 'Servo motor' },
  { label: 'Wire begin', insert: 'Wire.begin();', doc: 'I2C start' },
  { label: 'SPI', insert: '#include <SPI.h>\nSPI.begin();', doc: 'SPI start' },
  { label: 'interrupt', insert: 'attachInterrupt(digitalPinToInterrupt(${1:2}), ${2:ISR}, ${3:RISING});', doc: 'Interrupt' },
];

const ESP32_SNIPPETS = [
  { label: 'WiFi connect', insert: '#include <WiFi.h>\nWiFi.begin("${1:ssid}", "${2:password}");\nwhile (WiFi.status() != WL_CONNECTED) { delay(500); }', doc: 'WiFi' },
  { label: 'BLE', insert: '#include <BLEDevice.h>\nBLEDevice::init("${1:Velxio}");', doc: 'Bluetooth LE' },
  { label: 'ESP32 PWM', insert: 'ledcSetup(${1:0}, ${2:5000}, ${3:8});\nledcAttachPin(${4:2}, ${1:0});\nledcWrite(${1:0}, ${5:128});', doc: 'ESP32 PWM' },
  { label: 'WiFi AP', insert: 'WiFi.softAP("${1:VelxioAP}", "${2:password123}");', doc: 'WiFi AP' },
];

const SENSOR_SNIPPETS = [
  { label: 'DHT22', insert: '#include <DHT.h>\n#define DHTPIN ${1:2}\n#define DHTTYPE DHT22\nDHT dht(DHTPIN, DHTTYPE);\nfloat t = dht.readTemperature();', doc: 'DHT temp sensor' },
  { label: 'SSD1306 OLED', insert: '#include <Wire.h>\n#include <Adafruit_GFX.h>\n#include <Adafruit_SSD1306.h>\nAdafruit_SSD1306 display(128,64,&Wire,-1);\ndisplay.begin(SSD1306_SWITCHCAPVCC, 0x3C);', doc: 'OLED display' },
  { label: 'HC-SR04', insert: 'long duration, distance;\ndigitalWrite(trigPin, LOW); delayMicroseconds(2);\ndigitalWrite(trigPin, HIGH); delayMicroseconds(10);\ndigitalWrite(trigPin, LOW);\nduration = pulseIn(echoPin, HIGH);\ndistance = duration*0.034/2;', doc: 'Ultrasonic sensor' },
  { label: 'MPU6050', insert: '#include <Wire.h>\n#include <MPU6050.h>\nMPU6050 mpu;\nmpu.initialize();', doc: 'Gyro/Accel' },
  { label: 'NeoPixel', insert: '#include <Adafruit_NeoPixel.h>\nAdafruit_NeoPixel strip(${1:16}, ${2:6}, NEO_GRB + NEO_KHZ800);\nstrip.begin();\nstrip.setPixelColor(${3:0}, strip.Color(255,0,0));\nstrip.show();', doc: 'WS2812 LED strip' },
];

const ALL_BOARDS = Object.keys((catalogData as any).boards || {});
const ALL_PARTS = Object.keys((catalogData as any).parts || {});

export function registerCursorCompletions(monaco: Monaco) {
  const languages = ['cpp', 'c'];
  for (const lang of languages) {
    monaco.languages.registerCompletionItemProvider(lang, {
      triggerCharacters: ['.', '#', '<', '"', '@', ' ', '/'],
      provideCompletionItems: (model, position) => {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        
        const suggestions: any[] = [];
        const lineContent = model.getLineContent(position.lineNumber);
        const beforeCursor = lineContent.substring(0, position.column - 1);
        
        // @ mentions - Cursor style
        if (beforeCursor.includes('@') || beforeCursor.endsWith('@') || beforeCursor.match(/@\w*$/)) {
          const files = useEditorStore.getState().files;
          for (const f of files) {
            suggestions.push({
              label: `@${f.name}`,
              kind: monaco.languages.CompletionItemKind.File,
              insertText: f.name,
              detail: `${f.content.length} chars - file`,
              documentation: `Reference file ${f.name}`,
              range,
              sortText: '0_' + f.name,
            });
          }
          const comps = useSimulatorStore.getState().components;
          for (const c of comps) {
            suggestions.push({
              label: `@${c.id}`,
              kind: monaco.languages.CompletionItemKind.Reference,
              insertText: c.id,
              detail: `${c.metadataId} - component`,
              documentation: `Component ${c.metadataId} at ${c.x},${c.y}`,
              range,
              sortText: '1_' + c.id,
            });
          }
          // Board mentions
          const boards = useSimulatorStore.getState().boards;
          for (const b of boards) {
            suggestions.push({
              label: `@${b.boardKind} (${b.id})`,
              kind: monaco.languages.CompletionItemKind.Class,
              insertText: b.id,
              detail: `${b.boardKind} - board`,
              range,
              sortText: '2_' + b.id,
            });
          }
          // All boards from catalog
          for (const boardId of ALL_BOARDS.slice(0, 10)) {
            if (boardId.toLowerCase().includes(beforeCursor.split('@').pop()?.toLowerCase() || '') || beforeCursor.endsWith('@')) {
              suggestions.push({
                label: `@board:${boardId}`,
                kind: monaco.languages.CompletionItemKind.Class,
                insertText: boardId,
                detail: `Board - ${boardId}`,
                range,
                sortText: '3_' + boardId,
              });
            }
          }
        }
        
        // Arduino snippets - Cursor Tab completion
        for (const s of ARDUINO_SNIPPETS) {
          suggestions.push({
            label: s.label,
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: s.insert,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            detail: `Arduino - ${s.doc}`,
            documentation: s.doc,
            range,
            sortText: 'a_' + s.label,
          });
        }
        
        // ESP32 if present
        const boards = useSimulatorStore.getState().boards;
        const hasEsp = boards.some(b => b.boardKind.includes('esp32')) || ALL_BOARDS.some(b => b.includes('esp32'));
        if (hasEsp || beforeCursor.toLowerCase().includes('esp') || beforeCursor.toLowerCase().includes('wifi')) {
          for (const s of ESP32_SNIPPETS) {
            suggestions.push({
              label: s.label,
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertText: s.insert,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              detail: `ESP32 - ${s.doc}`,
              range,
              sortText: 'b_' + s.label,
            });
          }
        }
        
        // Sensors
        for (const s of SENSOR_SNIPPETS) {
          suggestions.push({
            label: s.label,
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: s.insert,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            detail: `Sensor - ${s.doc}`,
            range,
            sortText: 'c_' + s.label,
          });
        }
        
        // Component-based suggestions
        const comps = useSimulatorStore.getState().components;
        for (const c of comps.slice(0, 5)) {
          if (c.metadataId.includes('led')) {
            suggestions.push({
              label: `LED ${c.id} control`,
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertText: `digitalWrite(${c.id}_PIN, HIGH); // ${c.metadataId}`,
              detail: `Control ${c.id}`,
              range,
              sortText: 'd_' + c.id,
            });
          }
        }
        
        return { suggestions };
      }
    });
  }
  
  // Python for Pico, ESP32, Pi
  monaco.languages.registerCompletionItemProvider('python', {
    triggerCharacters: ['.', '@', ' ', '('],
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const lineContent = model.getLineContent(position.lineNumber);
      const beforeCursor = lineContent.substring(0, position.column - 1);
      
      const suggestions: any[] = [
        {
          label: 'machine.Pin',
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: 'from machine import Pin\nled = Pin(${1:25}, Pin.OUT)\nled.value(${2:1})',
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail: 'RP2040/ESP32 GPIO',
          range,
        },
        {
          label: 'time.sleep',
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: 'time.sleep(${1:1})',
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail: 'Delay',
          range,
        },
        {
          label: 'I2C scan',
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: 'from machine import I2C, Pin\ni2c = I2C(0, scl=Pin(5), sda=Pin(4))\nprint(i2c.scan())',
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail: 'I2C scan',
          range,
        },
      ];
      
      if (beforeCursor.includes('@')) {
        const files = useEditorStore.getState().files;
        for (const f of files) {
          suggestions.push({
            label: `@${f.name}`,
            kind: monaco.languages.CompletionItemKind.File,
            insertText: f.name,
            detail: 'file',
            range,
          });
        }
      }
      
      return { suggestions };
    }
  });
}

// --- Inline edit widget (Cmd+K) ---
let inlineEditWidget: HTMLElement | null = null;

export function showInlineEdit(editor: MonacoEditor.IStandaloneCodeEditor) {
  const selection = editor.getSelection();
  const selectedText = selection ? editor.getModel()?.getValueInRange(selection) || '' : '';
  const fileName = useEditorStore.getState().files.find(f => f.id === useEditorStore.getState().activeFileId)?.name || 'sketch.ino';
  
  if (inlineEditWidget) {
    inlineEditWidget.remove();
  }
  
  const widget = document.createElement('div');
  widget.className = 'cursor-inline-edit';
  widget.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: #1e1e1e;
    border: 1px solid #007acc;
    border-radius: 10px;
    padding: 16px;
    z-index: 10000;
    min-width: 480px;
    max-width: 600px;
    box-shadow: 0 16px 64px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,122,204,0.2);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  `;
  
  widget.innerHTML = `
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
      <div style="background:#007acc; color:white; width:24px; height:24px; border-radius:6px; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:12px;">K</div>
      <span style="color:#fff; font-size:14px; font-weight:600;">Cursor Inline Edit</span>
      <span style="color:#888; font-size:11px; background:#2a2a2a; padding:2px 6px; border-radius:4px;">⌘K</span>
      <button id="cursor-inline-close" style="margin-left:auto; background:#2a2a2a; border:1px solid #333; color:#888; cursor:pointer; width:24px; height:24px; border-radius:4px; display:flex; align-items:center; justify-content:center;">✕</button>
    </div>
    <div style="color:#aaa; font-size:12px; margin-bottom:8px; display:flex; align-items:center; gap:6px;">
      <span style="background:#252525; padding:2px 6px; border-radius:3px; font-family:monospace; font-size:11px;">${fileName}</span>
      ${selectedText ? `<span style="color:#666;">• ${selectedText.length} chars selected • ${selectedText.split('\n').length} lines</span>` : '<span style="color:#666;">• whole file</span>'}
    </div>
    <textarea id="cursor-inline-input" placeholder="Describe the change... e.g. 'Make LED blink faster with PWM' or 'Add button debounce and serial debug'" 
      style="width:100%; background:#252525; border:1px solid #3a3a3a; color:#fff; border-radius:6px; padding:10px; font-size:13px; min-height:80px; resize:vertical; font-family:inherit; outline:none;"></textarea>
    <div style="display:flex; gap:8px; margin-top:12px; align-items:center;">
      <button id="cursor-inline-apply" style="background:#007acc; color:white; border:none; padding:8px 16px; border-radius:6px; cursor:pointer; font-size:13px; font-weight:500; display:flex; align-items:center; gap:6px;">↵ Apply</button>
      <button id="cursor-inline-chat" style="background:#2a2a2a; color:#ccc; border:1px solid #444; padding:8px 14px; border-radius:6px; cursor:pointer; font-size:13px;">⌘L Chat</button>
      <button id="cursor-inline-composer" style="background:#2a2a2a; color:#ccc; border:1px solid #444; padding:8px 14px; border-radius:6px; cursor:pointer; font-size:13px;">⌘I Composer</button>
      <span style="color:#555; font-size:11px; margin-left:auto;">Esc to close • Ctrl+↵ to apply</span>
    </div>
    <div style="margin-top:10px; padding:8px; background:#252525; border-radius:4px; color:#666; font-size:10px; line-height:1.4;">
      <span style="color:#007acc; font-weight:600;">Velxio = Cursor</span> for hardware • ${ALL_BOARDS.length} boards • ${ALL_PARTS.length} components • @ mention files, components, boards • Tab to accept ghost text
    </div>
  `;
  
  document.body.appendChild(widget);
  inlineEditWidget = widget;
  
  const input = widget.querySelector('#cursor-inline-input') as HTMLTextAreaElement;
  input.focus();
  
  const close = () => {
    widget.remove();
    inlineEditWidget = null;
    editor.focus();
  };
  
  widget.querySelector('#cursor-inline-close')?.addEventListener('click', close);
  
  const applyEdit = async () => {
    const prompt = input.value.trim();
    if (!prompt) return;
    
    const model = editor.getModel();
    if (!model) return;
    
    if (selectedText && selection) {
      const lower = prompt.toLowerCase();
      let handled = false;
      let newText = selectedText;
      
      if (lower.includes('faster') && selectedText.includes('delay')) {
        newText = selectedText.replace(/delay\s*\(\s*(\d+)\s*\)/g, (_, n) => `delay(${Math.max(50, Math.floor(parseInt(n)/2))})`);
        handled = true;
      } else if (lower.includes('slower') && selectedText.includes('delay')) {
        newText = selectedText.replace(/delay\s*\(\s*(\d+)\s*\)/g, (_, n) => `delay(${parseInt(n)*2})`);
        handled = true;
      } else if (lower.includes('remove') && lower.includes('comment')) {
        newText = selectedText.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        handled = true;
      }
      
      if (handled && newText !== selectedText) {
        editor.executeEdits('cursor-inline', [{
          range: selection,
          text: newText,
        }]);
        close();
        return;
      }
    }
    
    // Complex edit -> delegate to agent (Cursor-like)
    const event = new CustomEvent('velxio-cursor-inline-edit', {
      detail: { prompt, selectedText, fileName }
    });
    window.dispatchEvent(event);
    close();
  };
  
  widget.querySelector('#cursor-inline-apply')?.addEventListener('click', applyEdit);
  widget.querySelector('#cursor-inline-chat')?.addEventListener('click', () => {
    const prompt = input.value.trim() || 'Help with this code';
    window.dispatchEvent(new CustomEvent('velxio-cursor-focus-chat', {
      detail: { prompt: selectedText ? `${prompt}\n\nContext from ${fileName}:\n\`\`\`\n${selectedText}\n\`\`\`` : prompt, context: selectedText }
    }));
    close();
  });
  widget.querySelector('#cursor-inline-composer')?.addEventListener('click', () => {
    const prompt = input.value.trim() || 'Edit circuit and code';
    window.dispatchEvent(new CustomEvent('velxio-cursor-composer', {
      detail: { prompt, fileName, context: selectedText }
    }));
    close();
  });
  
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      applyEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  
  const handleClickOutside = (e: MouseEvent) => {
    if (!widget.contains(e.target as Node)) {
      close();
      document.removeEventListener('mousedown', handleClickOutside);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', handleClickOutside), 150);
}

export function registerCursorKeybindings(monaco: Monaco, editor: MonacoEditor.IStandaloneCodeEditor) {
  editor.addAction({
    id: 'cursor.inlineEdit',
    label: 'Cursor: Inline Edit (⌘K) - Velxio',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK],
    contextMenuGroupId: '9_cursor',
    contextMenuOrder: 1,
    run: () => showInlineEdit(editor)
  });
  
  editor.addAction({
    id: 'cursor.addToChat',
    label: 'Cursor: Add to Chat (⌘L)',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL],
    contextMenuGroupId: '9_cursor',
    contextMenuOrder: 2,
    run: () => {
      const selection = editor.getSelection();
      const selectedText = selection ? editor.getModel()?.getValueInRange(selection) || '' : '';
      const fileName = useEditorStore.getState().files.find(f => f.id === useEditorStore.getState().activeFileId)?.name || 'unknown';
      window.dispatchEvent(new CustomEvent('velxio-cursor-focus-chat', {
        detail: { 
          prompt: selectedText ? `Explain this code from ${fileName}:\n\`\`\`\n${selectedText}\n\`\`\`` : `Help with ${fileName}`,
          context: selectedText 
        }
      }));
    }
  });
  
  editor.addAction({
    id: 'cursor.composer',
    label: 'Cursor: Composer (⌘I) - Multi-file edit',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI],
    contextMenuGroupId: '9_cursor',
    contextMenuOrder: 3,
    run: () => {
      const fileName = useEditorStore.getState().files.find(f => f.id === useEditorStore.getState().activeFileId)?.name;
      window.dispatchEvent(new CustomEvent('velxio-cursor-composer', { detail: { fileName } }));
    }
  });
  
  editor.addAction({
    id: 'cursor.commandPalette',
    label: 'Velxio: Command Palette (⌘⇧P)',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP],
    run: () => {
      (editor as any).trigger('velxio', 'editor.action.quickCommand', {});
    }
  });
  
  // Cursor-style: Cmd+Enter to accept all, Ctrl+Backspace to reject
  editor.addAction({
    id: 'cursor.acceptAll',
    label: 'Cursor: Accept All (⌘Enter)',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
    run: () => {
      window.dispatchEvent(new CustomEvent('velxio-cursor-accept-all'));
    }
  });
}

export function registerTabCompletion(monaco: Monaco, editor: MonacoEditor.IStandaloneCodeEditor) {
  let ghostDecoration: string[] = [];
  
  const ghostMap: Record<string, string> = {
    'digitalW': 'rite(pin, HIGH);',
    'pinM': 'ode(pin, OUTPUT);',
    'Serial.': 'println("");',
    'delay(': '1000);',
    'analogW': 'rite(pin, value);',
    'analogR': 'ead(A0);',
    'for (': 'int i=0; i<10; i++) {',
    'if (': 'condition) {',
    'void setup': '() {\n  Serial.begin(9600);\n}',
    'void loop': '() {\n  \n}',
  };
  
  const updateGhostText = () => {
    const position = editor.getPosition();
    if (!position) return;
    const model = editor.getModel();
    if (!model) return;
    
    const line = model.getLineContent(position.lineNumber);
    const before = line.substring(0, position.column - 1);
    const trimmed = before.trim();
    
    let ghost = '';
    for (const [key, val] of Object.entries(ghostMap)) {
      if (trimmed.endsWith(key) || before.endsWith(key)) {
        ghost = val;
        // Avoid duplicating if already typed
        if (key === 'delay(' && before.includes('delay(') && before.match(/delay\(\d/)) {
          ghost = '';
        }
        break;
      }
    }
    
    if (ghost) {
      const decorations = [{
        range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
        options: {
          after: {
            content: ghost,
            inlineClassName: 'cursor-ghost-text',
          }
        }
      }];
      ghostDecoration = editor.deltaDecorations(ghostDecoration, decorations);
    } else {
      ghostDecoration = editor.deltaDecorations(ghostDecoration, []);
    }
  };
  
  editor.onDidChangeModelContent(() => updateGhostText());
  editor.onDidChangeCursorPosition(() => updateGhostText());
  
  editor.addAction({
    id: 'cursor.acceptGhost',
    label: 'Cursor: Accept Ghost (Tab)',
    keybindings: [monaco.KeyCode.Tab],
    run: () => {
      if (ghostDecoration.length > 0) {
        const position = editor.getPosition();
        if (!position) return;
        const model = editor.getModel();
        if (!model) return;
        const line = model.getLineContent(position.lineNumber);
        const before = line.substring(0, position.column - 1);
        const trimmed = before.trim();
        let ghost = '';
        for (const [key, val] of Object.entries(ghostMap)) {
          if (trimmed.endsWith(key) || before.endsWith(key)) {
            ghost = val;
            break;
          }
        }
        if (ghost) {
          editor.executeEdits('cursor-tab', [{
            range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
            text: ghost,
          }]);
          ghostDecoration = editor.deltaDecorations(ghostDecoration, []);
          return;
        }
      }
      // @ts-ignore
      editor.trigger('cursor', 'tab', {});
    }
  });
}

export function injectCursorStyles() {
  if (document.getElementById('cursor-styles')) return;
  const style = document.createElement('style');
  style.id = 'cursor-styles';
  style.textContent = `
    .cursor-ghost-text {
      color: #6e7681 !important;
      opacity: 0.55;
      font-style: italic;
    }
    .cursor-inline-edit textarea:focus {
      outline: 1px solid #007acc;
      border-color: #007acc !important;
    }
    .cursor-diff-added {
      background: rgba(46, 160, 67, 0.15) !important;
      border-left: 3px solid #2ea043;
    }
    .cursor-diff-removed {
      background: rgba(248, 81, 73, 0.15) !important;
      text-decoration: line-through;
      opacity: 0.6;
    }
    @keyframes cursorPulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
  `;
  document.head.appendChild(style);
}
