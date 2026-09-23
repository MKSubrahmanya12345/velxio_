import StepCard from './StepCard';

export default function HowItWorks() {
  const steps = [
    ['1 · Classify', 'Prompt → Jev classifies the build (D1).'],
    ['2 · Decompose', 'LLM splits it into parts: frame, motors, ESC, FC, props, RX, video, battery, firmware…'],
    ['3 · Research loop', 'Each part runs research → gather → understand → data in parallel (web + model).'],
    ['4 · Index', 'Findings are indexed so similar topics reuse prior research (speed-up).'],
    ['5 · Gate', 'Jev gates completion + human-eyes (D4–D6). You approve with your own eyes.'],
    ['6 · Persist', 'State: IDEA → CURRENT → VERIFIED. Agent keeps going until you are satisfied.'],
  ];
  return (
    <div className="panel">
      <h3>How WireGI works</h3>
      {steps.map(([t, d]) => (
        <StepCard key={t} title={t}>
          <div style={{ fontSize: 13 }}>{d}</div>
        </StepCard>
      ))}
      <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8 }}>
        Provider + Jev keys are reused from forge/server/.env. No new .env created.
      </p>
    </div>
  );
}
