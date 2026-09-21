const STEPS = [
  {
    num: '01',
    title: 'Gate',
    desc: 'Jev runs a feasibility gate — category, risk, effort, budget. Not buildable, or not safe? It says no, politely, before a single part is bought.',
  },
  {
    num: '02',
    title: 'Synthesize',
    desc: 'The planner turns the goal into phases, atomic steps, a bill of materials and acceptance criteria. Electronic sub-assemblies get a sim track on Velxio.',
  },
  {
    num: '03',
    title: 'Build together',
    desc: 'One step at a time. You do it with your hands; Jev verifies every report, scores substitutes, gates on safety — and shows its confidence the whole way.',
  },
];

export function HowItWorks() {
  return (
    <div className="fg-hip">
      {STEPS.map((s) => (
        <div key={s.num} className="fg-hip-card">
          <span className="fg-hip-num">{s.num}</span>
          <span className="fg-hip-title">{s.title}</span>
          <span className="fg-hip-desc">{s.desc}</span>
        </div>
      ))}
    </div>
  );
}
