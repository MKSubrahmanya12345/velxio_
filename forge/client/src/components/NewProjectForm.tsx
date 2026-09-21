import { useState, type FormEvent } from 'react';
import { api } from '../api';
import type { Project } from '../types';

const EXAMPLES = [
  'Build me a working iron man helmet',
  'Build me an MP3 player',
  'Build an LED desk lamp',
];

export function NewProjectForm({ onCreated }: { onCreated: (p: Project) => void }) {
  const [goal, setGoal] = useState('');
  const [skill, setSkill] = useState('intermediate');
  const [time, setTime] = useState('multi_day');
  const [budget, setBudget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!goal.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.createProject(goal.trim(), {
        skill,
        time,
        budget_usd: budget ? Number(budget) : null,
      });
      const c = r.conversation;
      if (!c.projectState) throw new Error(r.response.content || 'No build plan was created. Try clarifying your goal.');
      onCreated({ id: c.id, createdAt: c.createdAt, updatedAt: c.updatedAt, state: c.projectState });
    } catch (err) {
      setError(String((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="fg-form" onSubmit={submit}>
      <label className="fg-field">
        <span className="fg-field-label">Goal</span>
        <textarea
          className="fg-input fg-textarea"
          rows={2}
          placeholder="Build me a working iron man helmet"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
        />
        <span className="fg-field-hint">
          Anything buildable — electronics, mechanical, software, food. The feasibility gate will flag anything not buildable or not safe.
        </span>
      </label>

      <div className="fg-chips">
        {EXAMPLES.map((ex) => (
          <button key={ex} type="button" className="fg-chip" onClick={() => setGoal(ex)}>
            {ex}
          </button>
        ))}
      </div>

      <div className="fg-row">
        <label className="fg-field">
          <span className="fg-field-label">Your skill</span>
          <select className="fg-input" value={skill} onChange={(e) => setSkill(e.target.value)}>
            <option value="novice">Novice</option>
            <option value="intermediate">Intermediate</option>
            <option value="expert">Expert</option>
          </select>
        </label>
        <label className="fg-field">
          <span className="fg-field-label">Time budget</span>
          <select className="fg-input" value={time} onChange={(e) => setTime(e.target.value)}>
            <option value="weekend">A weekend</option>
            <option value="multi_day">A few days</option>
            <option value="multi_week">A few weeks</option>
          </select>
        </label>
        <label className="fg-field">
          <span className="fg-field-label">Budget (USD, optional)</span>
          <input
            className="fg-input"
            type="number"
            min="0"
            placeholder="150"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
          />
        </label>
        <button className="fg-btn fg-btn-primary" disabled={busy || !goal.trim()}>
          {busy ? 'Synthesizing…' : 'Synthesize build →'}
        </button>
      </div>

      {error && <div className="fg-banner fg-banner-error">{error}</div>}
    </form>
  );
}
