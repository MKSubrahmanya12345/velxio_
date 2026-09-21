import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryPanel } from '../components/MemoryPanel';
import { streamTurn } from '../api';
import type { MemoryEvent, MemoryNote, ProjectMemory } from '../types';

const rule: MemoryNote = { id: 'note_1', kind: 'rule', text: 'Only me, no other actors or crew.', quote: 'Only me, no other actors or crew.', origin: 'user', status: 'active', reason: 'Grounded in your message and accepted by JEV.', supersedes: [], sourceMessageId: 'msg_1', createdAt: '2026-09-21T10:00:00Z' };
const event = (extra: Partial<MemoryEvent> = {}): MemoryEvent => ({ id: 'event_1', turnId: 'turn_1', stage: 'check', status: 'complete', label: 'Response passed the active-memory checks', at: rule.createdAt, providers: { generator: 'mock', jev: 'mock' }, checks: [{ noteId: rule.id, text: rule.text, kind: rule.kind, value: .96, verdict: 'pass' }], noteIds: [rule.id], ...extra });
const memory: ProjectMemory = { version: 1, revision: 1, notes: [rule, { ...rule, id: 'note_2', text: 'Consider found footage.', kind: 'suggestion', status: 'proposed', origin: 'ai', quote: '' }], events: [event()] };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('shows user rules, tentative AI ideas, their provenance, and actual JEV usage', async () => {
  render(<MemoryPanel memory={memory} />);
  expect(screen.getByText('Binding')).toBeInTheDocument();
  expect(screen.getByText('AI suggestion')).toBeInTheDocument();
  expect(screen.getByText('proposed')).toBeInTheDocument();
  expect(screen.getByText('Demo JEV · heuristics')).toBeInTheDocument();
  expect(screen.getByText(/Demo check · respected by response/)).toBeInTheDocument();
  await userEvent.click(screen.getAllByText('Why is this here?')[0]);
  expect(screen.getByText('“Only me, no other actors or crew.”')).toBeVisible();
  expect(screen.getAllByText('Source: msg_1')[0]).toBeVisible();
});

it('shows new proposals as unapproved, animates checked rules, and resets to persisted memory on error', () => {
  const proposal = { ...rule, id: 'candidate_1', text: 'A new candidate' };
  const first = event({ id: 'extraction', stage: 'extract', proposals: [proposal], checks: undefined });
  const { rerender, container } = render(<MemoryPanel memory={memory} events={[first]} busy />);
  expect(screen.getByText('Proposed · awaiting JEV')).toBeInTheDocument();
  expect(screen.getByText('A new candidate')).toBeInTheDocument();
  rerender(<MemoryPanel memory={memory} events={[event({ status: 'running' })]} busy />);
  expect(container.querySelector('.is-checking')).not.toBeNull();
  rerender(<MemoryPanel memory={memory} events={[first]} error="Disconnected" />);
  expect(screen.queryByText('A new candidate')).not.toBeInTheDocument();
  expect(screen.getByRole('status', { name: 'Memory processing' })).toHaveTextContent('not confirmed');
});

it('retains superseded notes behind history and requests changes rather than mutating memory', async () => {
  const onChange = vi.fn();
  const old = { ...rule, id: 'old_rule', status: 'superseded' as const, text: 'Old requirement' };
  render(<MemoryPanel memory={{ ...memory, notes: [rule, old] }} onChange={onChange} />);
  expect(screen.queryByText('Old requirement')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Show retired / rejected notes' }));
  expect(screen.getByText('Old requirement')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Change this note ↗' }));
  expect(onChange).toHaveBeenCalledWith(rule);
});

it('labels animation playback as a replay, not a fresh model call', async () => {
  vi.useFakeTimers();
  render(<MemoryPanel memory={{ ...memory, events: [event({ id: 'a', stage: 'extract', label: 'Notes formed' }), event()] }} />);
  act(() => screen.getByRole('button', { name: 'Replay recorded turn ↻' }).click());
  expect(screen.getByRole('status', { name: 'Memory processing' })).toHaveTextContent('Replay · Notes formed');
  act(() => vi.advanceTimersByTime(650));
  expect(screen.getByRole('status', { name: 'Memory processing' })).toHaveTextContent('Replay · Response passed');
  act(() => vi.advanceTimersByTime(650));
  expect(screen.getByRole('status', { name: 'Memory processing' })).toHaveTextContent('Last turn');
});

it('separates contradiction from uncertainty and exposes raw JEV answers', async () => {
  const uncertain: MemoryNote = { ...rule, id: 'note_3', kind: 'fact', domain: 'production', text: 'I have a phone', status: 'pending', reason: 'Compatibility is uncertain — JEV did not identify a contradiction, but did not clear it either.' };
  const checked = event({
    checks: [
      { noteId: uncertain.id, text: uncertain.text, kind: 'fact', value: .4, verdict: 'uncertain', blocking: false },
      { noteId: rule.id, text: rule.text, kind: 'rule', value: .02, verdict: 'conflict', blocking: true },
    ],
    blocking: [{ type: 'contradiction', noteId: rule.id, text: rule.text, value: .02 }],
    raw: { model: 'jev-x', answers: { respect_0: { type: 'noul', noul: .02 } } },
  });
  render(<MemoryPanel memory={{ ...memory, notes: [rule, uncertain], events: [checked] }} />);
  expect(screen.getAllByText(/uncertain — not a confirmed conflict/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/contradiction found/).length).toBeGreaterThan(0);
  expect(screen.getByText(/held by: contradiction — Only me, no other actors or crew\./)).toBeInTheDocument();
  await userEvent.click(screen.getByText(/Decision trail/));
  await userEvent.click(screen.getByText('Raw JEV response'));
  expect(screen.getByText(/"noul": 0.02/)).toBeVisible();
});

it('consumes split UTF-8 progress packets and returns only the confirmed result', async () => {
  const e = event({ label: 'JEV → checking' });
  const raw = new TextEncoder().encode(JSON.stringify({ type: 'progress', event: e }) + '\n' + JSON.stringify({ type: 'result', result: { ok: true } }));
  const body = new ReadableStream({ start(controller) { for (let i = 0; i < raw.length; i += 3) controller.enqueue(raw.slice(i, i + 3)); controller.close(); } });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } })));
  const progress = vi.fn();
  expect(await streamTurn('/chat', { goal: 'film' }, progress)).toEqual({ ok: true });
  expect(progress).toHaveBeenCalledWith(e);
});

it('rejects interrupted streams and backend error packets without treating progress as success', async () => {
  for (const payload of [JSON.stringify({ type: 'progress', event: event() }) + '\n', JSON.stringify({ type: 'error', error: 'JEV unavailable' }) + '\n']) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(payload, { headers: { 'Content-Type': 'application/x-ndjson' } })));
    await expect(streamTurn('/chat', {}, vi.fn())).rejects.toThrow(/confirmation|JEV unavailable/);
  }
});
