import { describe, expect, it } from 'vitest';
import { derive, setField } from '../buildlab/derive';
import { openSim, tick } from '../buildlab/flight';
import { research, revise } from '../buildlab/intent';

function fly(prompt: string, seconds: number, prep?: (live: ReturnType<typeof openSim>) => void) {
  const config = research(prompt);
  const dossier = derive(config);
  const live = openSim(dossier.plan);
  live.armed = true;
  prep?.(live);
  const samples = [];
  const step = 20;
  for (let t = 0; t < seconds * 1000; t += step) samples.push(tick(live, step));
  return { config, dossier, live, last: samples[samples.length - 1], samples };
}

describe('build lab research', () => {
  it('treats a bare drone as a light first aircraft and says so', () => {
    const config = research('I wanna build a drone');
    expect(config.archetype).toBe('multirotor');
    expect(config.preset).toBe('first-light');
    expect(config.massKg).toBeGreaterThan(0.1);
    expect(config.massKg).toBeLessThan(0.2);
    const dossier = derive(config);
    expect(dossier.notes.some((n) => n.id === 'assume-size')).toBe(true);
    expect(dossier.plan.kind).toBe('multirotor');
    if (dossier.plan.kind === 'multirotor') {
      expect(dossier.plan.hoverFraction).toBeGreaterThan(0.08);
      expect(dossier.plan.hoverFraction).toBeLessThan(0.4);
    }
    expect(dossier.sources.length).toBeGreaterThan(0);
    expect(dossier.wires.length).toBeGreaterThan(0);
  });

  it('maps a 5-inch freestyle sentence onto the published hover band', () => {
    const config = research('5-inch freestyle quad on 6S');
    expect(config.preset).toBe('five-freestyle');
    expect(config.cells).toBe(6);
    expect(config.massKg).toBeCloseTo(0.62, 2);
    const dossier = derive(config);
    expect(dossier.plan.kind).toBe('multirotor');
    if (dossier.plan.kind !== 'multirotor') return;
    expect(dossier.plan.hoverFraction).toBeCloseTo(0.25, 2);
    expect(dossier.classCard?.title).toMatch(/5/);
    expect(dossier.warnings.some((w) => w.level === 'block')).toBe(false);
  });

  it('flags an Indian micro build instead of pretending it is a nano', () => {
    const config = research('5 inch freestyle I can fly in India');
    expect(config.jurisdiction).toBe('IN');
    const dossier = derive(config);
    expect(dossier.notes.some((n) => n.id === 'law-in')).toBe(true);
    expect(dossier.warnings.some((w) => /not a nano/i.test(w.text))).toBe(true);
  });

  it('keeps one project and amends a follow-up instead of starting over', () => {
    const first = research('I wanna build a drone');
    const revised = revise(first, 'make it a 5-inch freestyle on 6S');
    expect(revised.action).toBe('amend');
    expect(revised.config.preset).toBe('five-freestyle');
    expect(revised.config.archetype).toBe('multirotor');
    const switched = revise(revised.config, 'now a small rover');
    expect(switched.action).toBe('switch');
    expect(switched.config.archetype).toBe('surface');
  });

  it('marks a field the human edits as confirmed', () => {
    const config = setField(research('I wanna build a drone'), 'thrustPerMotorN', '3.2');
    expect(config.thrustPerMotorN).toBeCloseTo(3.2);
    expect(config.confirmed).toContain('thrustPerMotorN');
    const dossier = derive(config);
    expect(dossier.fields.find((f) => f.id === 'thrustPerMotorN')?.confidence).toBe('needs-you');
  });
});

describe('build lab simulation', () => {
  it('hovers a bare drone near the altitude the human was handed', () => {
    const { dossier, last } = fly('I wanna build a drone', 8);
    expect(dossier.plan.kind).toBe('multirotor');
    const target = dossier.plan.kind === 'multirotor' ? dossier.plan.hoverAltitude : 1.4;
    expect(last.alt).toBeGreaterThan(target - 0.45);
    expect(last.alt).toBeLessThan(target + 0.55);
    expect(Math.hypot(last.x, last.z)).toBeLessThan(1.2);
    expect(last.tiltDeg).toBeLessThan(18);
    expect(last.grounded).toBe(false);
  });

  it('hovers the 5-inch class too', () => {
    const { last, dossier } = fly('5-inch freestyle quad on 6S', 8);
    const target = dossier.plan.kind === 'multirotor' ? dossier.plan.hoverAltitude : 2;
    expect(last.alt).toBeGreaterThan(target - 0.6);
    expect(last.alt).toBeLessThan(target + 0.7);
    expect(last.tiltDeg).toBeLessThan(20);
  });

  it('drives a rover forward when the human gives it throttle', () => {
    const { last } = fly('a small rover that drives across the bench', 3, (live) => {
      live.stick.mode = 'manual';
      live.stick.throttle = 1;
    });
    expect(last.z).toBeGreaterThan(0.8);
    expect(last.grounded).toBe(true);
  });

  it('sends a model rocket up and records an apogee', () => {
    const { last } = fly('a model rocket', 6);
    expect(last.apogee).toBeGreaterThan(8);
  });

  it('holds a single-link arm against gravity', () => {
    const { last } = fly('a robot arm for the bench', 4);
    // θ is stored in alt for the joint model; target is 0.6 * 90°.
    expect(last.pitchDeg).toBeGreaterThan(40);
    expect(last.pitchDeg).toBeLessThan(70);
    expect(Math.abs(last.speed)).toBeLessThan(0.4);
  });
});
