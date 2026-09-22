/**
 * Velxio = Cursor: Command Palette (Cmd+Shift+P, Cmd+P)
 * Cursor-style quick open and command palette
 */
import { useEffect, useState, useRef } from 'react';
import { useEditorStore } from '../../store/useEditorStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { runEditorCommand } from '../../lib/editorCommands';
import { catalog } from '../../agent/catalog';
import { Search, FileCode, Cpu, Zap, MessageSquare, Layers } from 'lucide-react';

interface Command {
  id: string;
  label: string;
  desc: string;
  icon: string;
  action: () => void;
  keywords: string[];
}

export function CursorCommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  
  const files = useEditorStore((s) => s.files);
  const activeFileId = useEditorStore((s) => s.activeFileId);
  const setActiveFile = useEditorStore((s) => s.setActiveFile);
  const openFile = useEditorStore((s) => s.openFile);
  const components = useSimulatorStore((s) => s.components);
  const boards = useSimulatorStore((s) => s.boards);
  
  const commands: Command[] = [
    { id: 'cursor.chat', label: 'Cursor: Focus Chat (⌘L)', desc: 'Open agent chat panel', icon: '💬', action: () => window.dispatchEvent(new CustomEvent('velxio-cursor-focus-chat')), keywords: ['chat', 'agent', 'ai'] },
    { id: 'cursor.inline', label: 'Cursor: Inline Edit (⌘K)', desc: 'Edit selection with AI', icon: '✏️', action: () => {}, keywords: ['inline', 'edit', 'k'] },
    { id: 'cursor.composer', label: 'Cursor: Composer (⌘I)', desc: 'Multi-file circuit+code edits', icon: '🎼', action: () => window.dispatchEvent(new CustomEvent('velxio-cursor-composer')), keywords: ['composer', 'multi', 'file'] },
    { id: 'file.new', label: 'File: New File', desc: 'Create new file', icon: '📄', action: () => runEditorCommand('file.new'), keywords: ['new', 'file'] },
    { id: 'project.save', label: 'Project: Save', desc: 'Save project as .vlx', icon: '💾', action: () => runEditorCommand('project.save'), keywords: ['save', 'project'] },
    { id: 'project.export', label: 'Project: Export', desc: 'Export project', icon: '📦', action: () => runEditorCommand('project.export'), keywords: ['export'] },
    { id: 'sim.compile', label: 'Simulation: Compile', desc: 'Compile current board', icon: '🔨', action: () => runEditorCommand('sim.compile'), keywords: ['compile', 'build'] },
    { id: 'sim.run', label: 'Simulation: Run', desc: 'Run simulation', icon: '▶️', action: () => runEditorCommand('sim.run'), keywords: ['run', 'start'] },
    { id: 'sim.stop', label: 'Simulation: Stop', desc: 'Stop simulation', icon: '⏹️', action: () => runEditorCommand('sim.stop'), keywords: ['stop'] },
    { id: 'view.reset', label: 'View: Reset Canvas', desc: 'Reset canvas view', icon: '🔄', action: () => runEditorCommand('view.reset'), keywords: ['reset', 'view'] },
    { id: 'edit.format', label: 'Edit: Format Document', desc: 'Format current file', icon: '✨', action: () => runEditorCommand('edit.formatDocument'), keywords: ['format'] },
  ];
  
  // Add file commands
  const fileCommands: Command[] = files.map(f => ({
    id: `file.open.${f.id}`,
    label: `Open: ${f.name}`,
    desc: `${f.content.length} chars`,
    icon: '📄',
    action: () => { setActiveFile(f.id); openFile(f.id); },
    keywords: ['open', f.name],
  }));
  
  // Add board commands
  const boardCommands: Command[] = boards.map(b => ({
    id: `board.${b.id}`,
    label: `Board: ${b.id} (${b.boardKind})`,
    desc: `${b.boardKind} at ${b.x},${b.y}`,
    icon: '💻',
    action: () => {},
    keywords: ['board', b.boardKind, b.id],
  }));
  
  // Add component search
  const partCommands: Command[] = Object.entries(catalog.parts)
    .filter(([id]) => id.toLowerCase().includes(query.toLowerCase()) || query.length < 2)
    .slice(0, 10)
    .map(([id, spec]: any) => ({
      id: `part.${id}`,
      label: `Add Component: ${spec.name} (${id})`,
      desc: `${spec.category} - ${spec.pins?.length || 0} pins`,
      icon: '🧩',
      action: () => {
        window.dispatchEvent(new CustomEvent('velxio-add-component', { detail: { metadataId: id } }));
      },
      keywords: [id, spec.name, spec.category],
    }));
  
  const allCommands = [...commands, ...fileCommands, ...boardCommands, ...(query ? partCommands : [])];
  
  const filtered = query ? allCommands.filter(c => 
    c.label.toLowerCase().includes(query.toLowerCase()) ||
    c.desc.toLowerCase().includes(query.toLowerCase()) ||
    c.keywords.some(k => k.toLowerCase().includes(query.toLowerCase()))
  ) : allCommands.slice(0, 20);
  
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setOpen(v => !v);
        setQuery('');
        setSelected(0);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p' && !e.shiftKey) {
        // Quick open - files only
        e.preventDefault();
        setOpen(true);
        setQuery('');
        setSelected(0);
      }
      if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open]);
  
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);
  
  if (!open) return null;
  
  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0,0,0,0.5)',
      zIndex: 9999,
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'center',
      paddingTop: '20vh',
    }} onClick={() => setOpen(false)}>
      <div style={{
        background: '#1e1e1e',
        border: '1px solid #333',
        borderRadius: '8px',
        width: '600px',
        maxWidth: '90vw',
        maxHeight: '60vh',
        overflow: 'hidden',
        boxShadow: '0 16px 64px rgba(0,0,0,0.6)',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '12px', borderBottom: '1px solid #333', gap: '8px' }}>
          <Search size={16} style={{ color: '#666' }} />
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); setSelected(0); }}
            placeholder="Type a command or search... (Velxio = Cursor) • ⌘P files • ⇧⌘P commands • @ mentions"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              color: '#fff',
              fontSize: '14px',
              outline: 'none',
            }}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelected(s => Math.min(s + 1, filtered.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelected(s => Math.max(s - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                const cmd = filtered[selected];
                if (cmd) {
                  cmd.action();
                  setOpen(false);
                }
              }
            }}
          />
          <span style={{ fontSize: '10px', color: '#666', background: '#2a2a2a', padding: '2px 6px', borderRadius: '4px' }}>
            {filtered.length} results
          </span>
        </div>
        
        <div style={{ overflow: 'auto', maxHeight: '400px' }}>
          {filtered.map((cmd, idx) => (
            <div
              key={cmd.id}
              onClick={() => { cmd.action(); setOpen(false); }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '8px 12px',
                background: idx === selected ? '#007acc22' : 'transparent',
                borderLeft: idx === selected ? '2px solid #007acc' : '2px solid transparent',
                cursor: 'pointer',
                color: idx === selected ? '#fff' : '#ccc',
              }}
              onMouseEnter={() => setSelected(idx)}
            >
              <span style={{ fontSize: '16px' }}>{cmd.icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '13px', fontWeight: idx === selected ? 600 : 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {cmd.label}
                </div>
                <div style={{ fontSize: '11px', color: '#888', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {cmd.desc}
                </div>
              </div>
            </div>
          ))}
          {filtered.length === 0 && (
            <div style={{ padding: '20px', textAlign: 'center', color: '#666', fontSize: '13px' }}>
              No commands matching "{query}"<br/>
              <span style={{ fontSize: '11px' }}>Try: file, board, compile, run, chat, composer, or component name</span>
            </div>
          )}
        </div>
        
        <div style={{ padding: '8px 12px', borderTop: '1px solid #333', display: 'flex', gap: '12px', fontSize: '10px', color: '#666' }}>
          <span><b>↑↓</b> Navigate</span>
          <span><b>↵</b> Select</span>
          <span><b>Esc</b> Close</span>
          <span style={{ marginLeft: 'auto', color: '#007acc' }}>Velxio = Cursor • {Object.keys(catalog.boards).length} boards • {Object.keys(catalog.parts).length} parts</span>
        </div>
      </div>
    </div>
  );
}
