import type { ReactNode } from 'react';
import StepCard from './StepCard';

export default function HowItWorks() {
  const steps: Array<[string, ReactNode]> = [
    ['1 · Classify', 'Prompt → a typed decision (D1) classifies the build and picks a domain profile.'],
    [
      '2 · Decompose',
      <span key="d">
        The LLM splits it into parts — frame, motors, ESC, FC, props, RX, video, battery, firmware, tools — with a
        breadth/risk plan from D2/D3.
      </span>,
    ],
    ['3 · Research loop', 'Each part runs research → gather → understand → data, in parallel, through a Jev triage gate.'],
    ['4 · Gate', 'Jev decides the cheapest safe path per part: reuse a sibling, skip to you, cheap model, or full pass.'],
    ['5 · Integrate', 'One cross-part pass hunts contradictions (battery ↔ ESC ↔ props) and patches them in code.'],
    ['6 · Verify', 'D4–D6 decides complete / needs-human / stop. Your “approve” is the top rung of the ladder.'],
  ];
  return (
    <div className="panel">
      <h3>How WireGI works</h3>
      {steps.map(([t, d]) => (
        <StepCard key={t} title={t}>
          <div className="small">{d}</div>
        </StepCard>
      ))}
      <h3 style={{ marginTop: 14 }}>Debugging</h3>
      <ul className="tight small">
        <li>
          <b>Flow</b> — every event with level, timing, part and payload. Provider attempts are shown as attempts, not
          as failures.
        </li>
        <li>
          <b>Debug</b> — env files, which key came from where, a live LLM test, ports, and this project's runs/errors.
        </li>
        <li>
          <b>Export</b> — download the whole trace as JSON.
        </li>
      </ul>
      <p className="muted small">
        Keys come from <code>WireGI/server/.env</code> (see <code>.env.example</code>). Forge's{' '}
        <code>forge/server/.env</code> is only a fallback, and only while <code>WIREGI_INHERIT_FORGE_ENV</code> is not
        false.
      </p>
    </div>
  );
}
