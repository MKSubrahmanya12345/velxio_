import type { FlowEntry, Part, Project } from '../types';
import type { RunState } from '../lib/useProject';

type Props = { project: Project | null; parts: Part[]; flow: FlowEntry[]; run: RunState; busy: boolean };

function statusForPart(part: Part) {
  const s = String((part as any).status || '').toLowerCase();
  if (s.includes('fail') || s.includes('error')) return 'error';
  if (s.includes('complete') || s.includes('done') || s.includes('verified') || (part as any).verified) return 'done';
  if (s.includes('research') || s.includes('pending')) return 'active';
  return 'idle';
}

function typeForPart(part: Part) {
  const text = `${part.name} ${(part as any).description || ''}`.toLowerCase();
  if (/esp|arduino|stm32|raspberry|mcu|microcontroller/.test(text)) return 'MCU';
  if (/oled|lcd|display|screen/.test(text)) return 'DISPLAY';
  if (/sensor|therm|imu|gyro|acceler|camera|mic/.test(text)) return 'SENSOR';
  if (/motor|servo|relay|led|actuator/.test(text)) return 'ACTUATOR';
  return 'COMPONENT';
}

export default function ProjectWorkspace({ project, parts, flow, run, busy }: Props) {
  const errorCount = flow.filter((e) => String((e as any).level || '').toLowerCase() === 'error').length;
  const completed = parts.filter((p) => statusForPart(p) === 'done').length;
  const active = busy || run.running;
  const progress = parts.length ? Math.round((completed / parts.length) * 100) : 0;

  return (
    <main className="project-workspace">
      <div className="workspace-head">
        <div><div className="eyebrow">PROJECT / SYSTEM VIEW</div><h2>{project?.goal || 'Untitled project'}</h2></div>
        <div className="workspace-state"><span className={`state-dot ${active ? 'active' : errorCount ? 'error' : 'idle'}`} />{active ? 'RUNNING' : errorCount ? `${errorCount} ERRORS` : 'READY'}</div>
      </div>
      <div className="workspace-toolbar"><span>GRAPH</span><span>SIMULATION</span><span>IO</span><div className="spacer" /><span className="mono">{parts.length} NODES</span><span className="mono">{completed}/{parts.length || 0} VERIFIED</span></div>
      <div className="system-canvas">
        <div className="canvas-grid" />
        {parts.length === 0 ? (
          <div className="canvas-empty"><div className="empty-mark">+</div><strong>NO SYSTEM NODES</strong><span>Describe the hardware or software you want to build.</span></div>
        ) : (
          <div className="node-grid">{parts.map((part, index) => {
            const status = statusForPart(part);
            return <div className={`system-node node-${status}`} key={part.id || index}>
              <div className="node-top"><span className="node-index">{String(index + 1).padStart(2, '0')}</span><span className="node-type">{typeForPart(part)}</span><span className={`node-status ${status}`} /></div>
              <strong>{part.name}</strong><span className="node-meta">{(part as any).description || 'system component'}</span>
              <div className="node-footer"><span>PART</span><span>{status.toUpperCase()}</span></div>
            </div>;
          })}</div>
        )}
      </div>
      <div className="workspace-bottom">
        <div className="runtime-card"><div className="section-label">RUNTIME</div><div className="runtime-row"><span>Agent</span><b>{active ? 'executing' : 'idle'}</b></div><div className="runtime-row"><span>Simulation</span><b>ready</b></div><div className="runtime-row"><span>Hardware bridge</span><b>standby</b></div></div>
        <div className="runtime-card progress-card"><div className="section-label">BUILD PROGRESS</div><div className="progress-big"><strong>{progress}%</strong><span>{completed} verified / {parts.length} nodes</span></div><div className="workspace-progress"><i style={{ width: `${progress}%` }} /></div></div>
      </div>
    </main>
  );
}
