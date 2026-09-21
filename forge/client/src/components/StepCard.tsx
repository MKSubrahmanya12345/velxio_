import { activeStepRef } from '../state';
import type { Project } from '../types';

const HAZARD_ORDER: Record<string, number> = { high: 0, warn: 1, info: 2 };

export function StepCard({ project, onSend }: { project: Project; onSend: (text: string, chip?: string) => void }) {
  const st = project.state;
  const ref = activeStepRef(st);
  if (!ref) return null;
  const { step, index, total, phase } = ref;

  const gate = st.safetyGate?.stepId === step.id ? st.safetyGate.flags : step.safety;
  const high = gate.filter((f) => f.severity === 'high' && f.present !== false);
  const warns = gate.filter((f) => f.severity === 'warn' && f.present !== false);
  const acked = !!st.safetyAcks[step.id];

  const invTokens = (name: string) =>
    st.inventory.flatMap((i) => [i.name, i.note || '']).join(' ').toLowerCase().match(/[a-z0-9]+/g) || [];
  const invSet = new Set(st.inventory.flatMap((i) => [i.name.toLowerCase(), i.note?.toLowerCase() ?? '']));
  const hasInInventory = (m: string) =>
    invSet.has(m.toLowerCase()) || m.split(/\s+/).some((t) => t.length > 2 && invSet.has(t.toLowerCase()));

  return (
    <article className="fg-card fg-stepcard">
      <header className="fg-stepcard-head">
        <span className="fg-stepnum">
          Step {index + 1} <em>/ {total}</em>
        </span>
        <span className={`fg-track-badge ${step.track === 'sim' ? 'fg-track-sim' : 'fg-track-phys'}`}>
          {step.track === 'sim' ? 'SIM · Velxio' : 'PHYSICAL'}
        </span>
        <span className="fg-phase-name">{phase?.name}</span>
      </header>

      <h2 className="fg-step-title">{step.title}</h2>
      {step.failed > 0 && <div className="fg-fails">⚠ {step.failed} failed attempt{step.failed > 1 ? 's' : ''} on this step</div>}
      <p className="fg-step-instructions">{step.instructions}</p>

      {(high.length > 0 || warns.length > 0) && (
        <div className={high.length ? 'fg-safety fg-safety-high' : 'fg-safety fg-safety-warn'}>
          <div className="fg-safety-title">
            {high.length ? '⚠ Safety — acknowledge before starting' : 'Safety notes'}
          </div>
          <ul>
            {[...high, ...warns].map((f, i) => (
              <li key={i}>{f.note || f.hazard}</li>
            ))}
          </ul>
          {high.length > 0 && !acked && (
            <button className="fg-btn fg-btn-secondary" onClick={() => onSend('', 'safety_ack')}>
              I understand the risks — acknowledge
            </button>
          )}
          {high.length > 0 && acked && <div className="fg-acked">✓ safety acknowledged</div>}
        </div>
      )}

      {step.track === 'sim' && (
        <div className="fg-sim-note">
          Sim-track step — this is verified in the Velxio circuit emulator before any physical work.
          M2 will run the simulation automatically; for now, do the check and report back.
        </div>
      )}

      <div className="fg-cols">
        <div className="fg-block">
          <div className="fg-block-title">Parts needed</div>
          {step.materials.length === 0 && <div className="fg-muted">None — tools only</div>}
          <ul className="fg-mats">
            {step.materials.map((m, i) => (
              <li key={i} className={hasInInventory(m) ? 'fg-mat-have' : 'fg-mat-need'}>
                {hasInInventory(m) ? '✓' : '▢'} {m}
              </li>
            ))}
          </ul>
        </div>
        <div className="fg-block">
          <div className="fg-block-title">Tools</div>
          <div className="fg-tools">
            {step.tools.length ? step.tools.map((t, i) => <span key={i} className="fg-tool-chip">{t}</span>) : <span className="fg-muted">—</span>}
          </div>
        </div>
      </div>

      <div className="fg-block">
        <div className="fg-block-title">Done when</div>
        <ul className="fg-dod">
          {step.definition_of_done.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      </div>
    </article>
  );
}
