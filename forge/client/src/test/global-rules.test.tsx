import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { api } from '../api';
import { GlobalRulesPanel } from '../components/GlobalRulesPanel';
import { MemoryPanel } from '../components/MemoryPanel';
import type { GlobalRule, GlobalRulesState, MemoryEvent } from '../types';

vi.mock('../api', () => ({ api: {
  health: vi.fn(), list: vi.fn(), create: vi.fn(), get: vi.fn(), message: vi.fn(), remove: vi.fn(),
  providers: { get: vi.fn() },
  globalRules: { list: vi.fn(), add: vi.fn(), update: vi.fn(), remove: vi.fn() },
} }));

const FILE = '/srv/forge/server/data/global-rules.json';
const rule = (id: string, text: string, extra: Partial<GlobalRule> = {}): GlobalRule => ({
  id, text, kind: 'rule', note: '', enabled: true, origin: 'user',
  createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z', disabledAt: null, disabledBy: null, ...extra,
});
const state = (rules: GlobalRule[]): GlobalRulesState => ({ rules, file: FILE });

beforeEach(() => {
  vi.mocked(api.list).mockResolvedValue([]);
  vi.mocked(api.health).mockResolvedValue({ ok: true, service: 'forge', time: '', providers: { jev: 'typesafe', planner: 'unconfigured', store: 'file' } } as never);
  vi.mocked(api.providers.get).mockResolvedValue(null as never);
  vi.mocked(api.globalRules.list).mockResolvedValue(state([]));
});

describe('global rules page', () => {
  it('is reachable from the header and shows the active-rule count', async () => {
    vi.mocked(api.globalRules.list).mockResolvedValue(state([rule('g1', 'Stay under ₹500.'), rule('g2', 'Old', { enabled: false })]));
    render(<App />);
    const button = await screen.findByRole('button', { name: /Global rules/ });
    await waitFor(() => expect(within(button).getByLabelText('1 active')).toBeInTheDocument());
    await userEvent.click(button);
    expect(await screen.findByRole('heading', { name: /Global JEV rules/ })).toBeInTheDocument();
    expect(await screen.findByText('Stay under ₹500.')).toBeInTheDocument();
  });

  it('adds a rule with a kind and note, then clears the form', async () => {
    const onChanged = vi.fn();
    const added = rule('g1', 'Prefer local parts.', { kind: 'preference', note: 'shipping is slow' });
    vi.mocked(api.globalRules.add).mockResolvedValue({ ok: true, rule: added, ...state([added]) });
    render(<GlobalRulesPanel onBack={() => {}} onChanged={onChanged} />);
    await screen.findByText('No global rules yet.');
    await userEvent.click(screen.getByRole('radio', { name: /Preference/ }));
    await userEvent.type(screen.getByLabelText('Rule text'), 'Prefer local parts.');
    await userEvent.type(screen.getByLabelText('Why (optional)'), 'shipping is slow');
    await userEvent.click(screen.getByRole('button', { name: '+ Add preference' }));
    expect(api.globalRules.add).toHaveBeenCalledWith({ text: 'Prefer local parts.', kind: 'preference', note: 'shipping is slow' });
    expect(await screen.findByText('Prefer local parts.', { selector: '.fg-rule-text' })).toBeInTheDocument();
    expect(screen.getByLabelText('Rule text')).toHaveValue('');
    expect(onChanged).toHaveBeenLastCalledWith(1);
  });

  it('blocks exact duplicates before calling the server', async () => {
    vi.mocked(api.globalRules.list).mockResolvedValue(state([rule('g1', 'Stay under ₹500.')]));
    render(<GlobalRulesPanel onBack={() => {}} />);
    await screen.findByText('Stay under ₹500.');
    await userEvent.type(screen.getByLabelText('Rule text'), 'stay under ₹500.');
    expect(screen.getByText('This exact rule already exists.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Add rule' })).toBeDisabled();
  });

  it('edits inline, toggles with a switch, and confirms deletes in place', async () => {
    const r = rule('g1', 'Stay under ₹500.');
    vi.mocked(api.globalRules.list).mockResolvedValue(state([r]));
    vi.mocked(api.globalRules.update).mockImplementation(async (_id, patch) => ({ ok: true, rule: { ...r, ...patch }, ...state([{ ...r, ...patch }]) }));
    vi.mocked(api.globalRules.remove).mockResolvedValue({ ok: true, ...state([]) });
    render(<GlobalRulesPanel onBack={() => {}} />);
    await screen.findByText('Stay under ₹500.');

    await userEvent.click(screen.getByRole('button', { name: 'Edit rule: Stay under ₹500.' }));
    const box = screen.getAllByLabelText('Rule text').find(el => el.closest('.fg-rule'))!;
    await userEvent.clear(box);
    await userEvent.type(box, 'Stay under ₹400.{Enter}');
    expect(api.globalRules.update).toHaveBeenCalledWith('g1', { text: 'Stay under ₹400.' });
    expect(await screen.findByText('Stay under ₹400.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('switch', { name: /Pause rule/ }));
    expect(api.globalRules.update).toHaveBeenLastCalledWith('g1', { enabled: false });
    expect(await screen.findByText('Paused', { selector: '.fg-pill' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Delete rule/ }));
    expect(api.globalRules.remove).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(api.globalRules.remove).toHaveBeenCalledWith('g1');
    expect(await screen.findByText('No global rules yet.')).toBeInTheDocument();
  });

  it('shows who paused a rule and offers a one-click restore', async () => {
    const r = rule('g1', 'No soldering.', { enabled: false, disabledBy: 'Removed by the JEV pre-turn gate: your message explicitly authorized it.' });
    vi.mocked(api.globalRules.list).mockResolvedValue(state([r]));
    vi.mocked(api.globalRules.update).mockResolvedValue({ ok: true, rule: { ...r, enabled: true }, ...state([{ ...r, enabled: true, disabledBy: null }]) });
    render(<GlobalRulesPanel onBack={() => {}} />);
    expect(await screen.findByText('Paused by JEV')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(api.globalRules.update).toHaveBeenCalledWith('g1', { enabled: true });
  });

  it('surfaces server errors without losing the draft', async () => {
    vi.mocked(api.globalRules.add).mockRejectedValue(new Error('API 409: This exact rule already exists.'));
    render(<GlobalRulesPanel onBack={() => {}} />);
    await screen.findByText('No global rules yet.');
    await userEvent.type(screen.getByLabelText('Rule text'), 'Something');
    await userEvent.click(screen.getByRole('button', { name: '+ Add rule' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('409');
    expect(screen.getByLabelText('Rule text')).toHaveValue('Something');
  });
});

describe('memory panel pre-turn gate', () => {
  it('shows which global and chat rules JEV put in force, and links to the rules page', async () => {
    const open = vi.fn();
    const gate: MemoryEvent = {
      id: 'e1', turnId: 't1', stage: 'gate', status: 'complete', label: 'Directive: 2 rules in force', at: '2026-09-23T00:00:00Z',
      providers: { generator: 'gemini', jev: 'typesafe' },
      directive: {
        mode: 'clarify_first', modeTrusted: true, ruleChange: null, gateSummary: '2 rules in force',
        applicableRules: [
          { id: 'g1', text: 'Stay under ₹500.', kind: 'rule', source: 'global', value: .97, unresolved: false },
          { id: 'n1', text: 'Only vanilla JS.', kind: 'rule', source: 'chat', value: null, unresolved: true },
        ],
      },
    };
    render(<MemoryPanel events={[gate]} onOpenGlobalRules={open} />);
    const card = screen.getByRole('region', { name: 'Pre-turn gate' });
    expect(within(card).getByText('mode · ask first')).toBeInTheDocument();
    expect(within(card).getByText('Stay under ₹500.')).toBeInTheDocument();
    expect(within(card).getByText(/kept in force/)).toBeInTheDocument();
    expect(within(card).getByText(/1 global rule applied/)).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: /Manage global rules/ }));
    expect(open).toHaveBeenCalled();
  });
});
