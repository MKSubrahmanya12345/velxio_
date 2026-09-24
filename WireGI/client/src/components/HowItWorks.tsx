const STEPS: Array<[string, string]> = [
  ['Classify', 'A typed decision (D1) classifies the build and picks a domain profile.'],
  ['Decompose', 'Split into parts — frame, motors, ESC, FC, props, RX, battery, firmware — with a breadth/risk plan (D2/D3).'],
  ['Research', 'Each part runs research → gather → understand → data, in parallel, through a Jev triage gate.'],
  ['Gate', 'Jev picks the cheapest safe path per part: reuse a sibling, skip to you, cheap model, or full pass.'],
  ['Integrate', 'One cross-part pass hunts contradictions (battery ↔ ESC ↔ props) and patches them.'],
  ['Verify', 'D4–D6 decides complete / needs-human / stop. Your “approve” is the top rung of the ladder.'],
];

/**
 * The explainer.
 *
 * Previously six bordered cards using the *part card* styling — which made each
 * step look clickable when none of them were — plus a second "Debugging"
 * section and a paragraph about .env precedence. About 250 words of
 * documentation, rendered in full at the bottom of the landing page on every
 * visit and again in the Help tab.
 *
 * It is now a six-line list. The debugging/env detail lives in the Debug tab,
 * which is the only place it is ever actionable.
 */
export default function HowItWorks() {
  return (
    <div className="how">
      <ol className="steps">
        {STEPS.map(([title, detail], i) => (
          <li key={title}>
            <b>
              {i + 1}. {title}
            </b>{' '}
            <span className="muted">{detail}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
