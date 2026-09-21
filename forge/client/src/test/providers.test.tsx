import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { api } from '../api';
import type { ProviderKey, ProvidersState } from '../types';

vi.mock('../api', () => ({ api: {
  health: vi.fn(), list: vi.fn(), create: vi.fn(), get: vi.fn(), message: vi.fn(), remove: vi.fn(),
  providers: {
    get: vi.fn(), addKey: vi.fn(), updateKey: vi.fn(), removeKey: vi.fn(),
    setActive: vi.fn(), testKey: vi.fn(), setFailover: vi.fn(), restoreEnv: vi.fn(), log: vi.fn(),
  },
} }));

const catalog = [
  { id: 'gemini', label: 'Google Gemini', short: 'Gemini', credentialLabel: 'Gemini API key', credentialPlaceholder: 'AIzaSy…', requiresKey: true, extraCredentials: [], defaultModel: 'gemini-2.5-flash', modelPlaceholder: 'gemini-2.5-flash', defaultBase: 'https://generativelanguage.googleapis.com/v1beta', baseLabel: 'API base', docs: 'https://aistudio.google.com/apikey' },
  { id: 'openrouter', label: 'OpenRouter', short: 'OpenRouter', credentialLabel: 'OpenRouter API key', credentialPlaceholder: 'sk-or-v1-…', requiresKey: true, extraCredentials: [], defaultModel: 'openai/gpt-4o-mini', modelPlaceholder: 'openai/gpt-4o-mini', defaultBase: 'https://openrouter.ai/api/v1', baseLabel: 'API base', docs: 'https://openrouter.ai/settings/keys' },
  { id: 'bedrock', label: 'AWS Bedrock', short: 'Bedrock', credentialLabel: 'AWS access key ID', credentialPlaceholder: 'AKIA…', requiresKey: true, extraCredentials: [{ field: 'secret', label: 'AWS secret access key', required: true, placeholder: 'secret' }, { field: 'region', label: 'AWS region', required: true, placeholder: 'us-east-1' }], defaultModel: 'anthropic.claude-sonnet-4-5', modelPlaceholder: 'anthropic.claude-sonnet-4-5', defaultBase: '', baseLabel: 'Endpoint override (optional)', docs: 'https://console.aws.amazon.com/iam/' },
  { id: 'ollama', label: 'Ollama (local)', short: 'Ollama', credentialLabel: 'API key (Ollama needs none — leave empty)', credentialPlaceholder: 'leave empty', requiresKey: false, extraCredentials: [], defaultModel: 'llama3.2', modelPlaceholder: 'llama3.2', defaultBase: 'http://localhost:11434', baseLabel: 'Ollama URL', docs: 'https://ollama.com/blog' },
  { id: 'openai', label: 'OpenAI-compatible (.env)', short: 'OpenAI-compatible', credentialLabel: 'API key', credentialPlaceholder: 'sk-…', requiresKey: true, extraCredentials: [], defaultModel: 'gpt-4o', modelPlaceholder: 'gpt-4o', defaultBase: 'https://api.openai.com/v1', baseLabel: 'API base', docs: 'https://platform.openai.com/docs' },
] as ProvidersState['catalog'];

const stats = { calls: 0, ok: 0, failures: 0, consecutiveFailures: 0, lastStatus: null, lastError: '', lastErrorAt: null, lastUsedAt: null, lastLatencyMs: null };

function key(id: string, provider: ProviderKey['provider'], note: string, extra: Partial<ProviderKey> = {}): ProviderKey {
  return {
    id, provider, providerLabel: catalog.find(c => c.id === provider)!.label, note,
    apiKey: provider === 'ollama' ? '' : `${provider}-key-${id}`, secret: '', sessionToken: '', region: '',
    baseUrl: catalog.find(c => c.id === provider)!.defaultBase, model: catalog.find(c => c.id === provider)!.defaultModel,
    enabled: true, origin: 'user', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    stats: { ...stats }, ...extra,
  };
}

function stateWith(keys: ProviderKey[], overrides: Partial<ProvidersState> = {}): ProvidersState {
  const enabled = keys.filter(k => k.enabled);
  return {
    catalog, keys, activeId: overrides.activeId ?? keys[0]?.id ?? '',
    active: keys[0] ? { id: keys[0].id, provider: keys[0].provider, label: keys[0].providerLabel, model: keys[0].model, note: keys[0].note } : null,
    failover: { enabled: true, maxRounds: 10, retryRejected: false },
    order: enabled.map(k => ({ id: k.id, provider: k.provider, note: k.note, model: k.model })),
    log: [], storage: { file: '/srv/forge/server/data/providers.json' }, configured: enabled.length > 0,
    env: { llm: false, bedrock: false }, ...overrides,
  };
}

async function openProviders() {
  await userEvent.click(screen.getByRole('button', { name: 'Providers' }));
  await screen.findByRole('heading', { name: /Keys, notes, and/i });
}

beforeEach(() => {
  vi.mocked(api.list).mockResolvedValue([]);
  vi.mocked(api.health).mockResolvedValue({ ok: true, service: 'forge', time: '', providers: { jev: 'typesafe', planner: 'unconfigured', store: 'file' }, failover: { enabled: true, maxRounds: 10, retryRejected: false, keys: 0, configured: false } });
  vi.mocked(api.providers.get).mockResolvedValue(stateWith([]));
});

describe('providers page', () => {
  it('offers the four providers and keeps the key in plain text with a note', async () => {
    render(<App />);
    await openProviders();

    for (const label of ['Google Gemini', 'OpenRouter', 'AWS Bedrock', 'Ollama \\(local\\)']) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeInTheDocument();
    }

    // The credential field is a text input, so what you type is what you see.
    const keyField = screen.getByLabelText('Gemini API key');
    expect(keyField).toHaveAttribute('type', 'text');
    await userEvent.type(keyField, 'AIza-plain-visible');
    expect(keyField).toHaveValue('AIza-plain-visible');

    await userEvent.type(screen.getByLabelText('Note'), 'main key · free tier');
    vi.mocked(api.providers.addKey).mockResolvedValue({
      ok: true,
      key: key('pk_1', 'gemini', 'main key · free tier', { apiKey: 'AIza-plain-visible' }),
      state: stateWith([key('pk_1', 'gemini', 'main key · free tier', { apiKey: 'AIza-plain-visible' })]),
    });

    await userEvent.click(screen.getByRole('button', { name: 'Add key' }));
    await waitFor(() => expect(api.providers.addKey).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'gemini', apiKey: 'AIza-plain-visible', note: 'main key · free tier', model: 'gemini-2.5-flash',
    })));

    // The saved card shows the whole key and the note — no masking, no dots.
    const card = (await screen.findByText('AIza-plain-visible', { selector: 'code' })).closest('li')!;
    expect(within(card).getByText('main key · free tier')).toBeInTheDocument();
    expect(within(card).queryByText(/•+/)).not.toBeInTheDocument();
    expect(screen.getByText(/Saved Google Gemini key/i)).toBeInTheDocument();
  });

  it('refuses to save a key with missing credentials and names them', async () => {
    render(<App />);
    await openProviders();
    await userEvent.click(screen.getByRole('button', { name: /AWS Bedrock/ }));
    await userEvent.type(screen.getByLabelText('Note'), 'team account');
    await userEvent.click(screen.getByRole('button', { name: 'Add key' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/AWS access key ID/);
    expect(screen.getByRole('alert')).toHaveTextContent(/AWS secret access key/);
    expect(api.providers.addKey).not.toHaveBeenCalled();
  });

  it('switches the form when another provider is picked', async () => {
    render(<App />);
    await openProviders();
    await userEvent.click(screen.getByRole('button', { name: /Ollama \(local\)/ }));
    expect(screen.getByLabelText(/API key \(Ollama needs none/i)).toHaveAttribute('type', 'text');
    expect(screen.getByLabelText('Ollama URL')).toHaveValue('http://localhost:11434');
    expect(screen.getByLabelText('Model')).toHaveValue('llama3.2');
  });

  it('selects any one key to run first and shows the loop order', async () => {
    const geminiKey = key('pk_g', 'gemini', 'primary');
    const routerKey = key('pk_o', 'openrouter', 'backup');
    vi.mocked(api.providers.get).mockResolvedValue(stateWith([geminiKey, routerKey]));
    render(<App />);
    await openProviders();

    // The loop order preview starts with the selected key.
    const loop = within(screen.getByRole('list', { name: 'Failover loop order' })).getAllByRole('listitem');
    expect(loop[0]).toHaveTextContent('gemini');
    expect(loop[0]).toHaveTextContent('primary');
    expect(loop[1]).toHaveTextContent('openrouter');

    vi.mocked(api.providers.setActive).mockResolvedValue({
      ok: true, activeId: 'pk_o', key: routerKey,
      state: stateWith([geminiKey, routerKey], { activeId: 'pk_o' }),
    });
    const cards = within(screen.getByRole('list', { name: 'Stored keys' })).getAllByRole('listitem');
    const backupCard = cards.find(li => within(li).queryByText('backup'))!;
    await userEvent.click(within(backupCard).getByRole('button', { name: 'Select' }));

    await waitFor(() => expect(api.providers.setActive).toHaveBeenCalledWith('pk_o'));
    await waitFor(() => expect(within(backupCard).getAllByText('selected').length).toBeGreaterThan(0));
    expect(screen.getByText(/OpenRouter “backup” now runs first/i)).toBeInTheDocument();
  });

  it('keeps the 10-round failover budget and lets it be changed', async () => {
    vi.mocked(api.providers.get).mockResolvedValue(stateWith([key('pk_g', 'gemini', 'primary'), key('pk_o', 'openrouter', 'backup')]));
    render(<App />);
    await openProviders();

    const rounds = screen.getByLabelText('Rounds before stopping');
    expect(rounds).toHaveValue(10);
    expect(screen.getByText(/10 rounds × 2 enabled keys = up to 20 attempts/i)).toBeInTheDocument();

    vi.mocked(api.providers.setFailover).mockResolvedValue({ ok: true, failover: { enabled: true, maxRounds: 4, retryRejected: false }, state: stateWith([], { }) });
    fireEvent.change(rounds, { target: { value: '4' } });
    fireEvent.blur(rounds);
    await waitFor(() => expect(api.providers.setFailover).toHaveBeenCalledWith({ maxRounds: 4 }));

    vi.mocked(api.providers.setFailover).mockResolvedValue({ ok: true, failover: { enabled: false, maxRounds: 4, retryRejected: false }, state: stateWith([]) });
    await userEvent.click(screen.getByRole('checkbox', { name: /Switch providers and keys automatically/i }));
    await waitFor(() => expect(api.providers.setFailover).toHaveBeenCalledWith({ enabled: false }));
  });

  it('tests a single key and reports the real outcome', async () => {
    const geminiKey = key('pk_g', 'gemini', 'primary');
    vi.mocked(api.providers.get).mockResolvedValue(stateWith([geminiKey]));
    vi.mocked(api.providers.testKey).mockResolvedValue({
      ok: false, keyId: 'pk_g', provider: 'gemini', model: 'gemini-2.5-flash', latencyMs: 42,
      status: 429, error: 'Gemini “primary” · gemini-2.5-flash returned HTTP 429: quota', state: stateWith([geminiKey]),
    });
    render(<App />);
    await openProviders();
    await userEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText(/Test failed \(HTTP 429\)/i)).toBeInTheDocument();
    expect(api.providers.testKey).toHaveBeenCalledWith('pk_g');
  });

  it('edits a note, disables a key, and deletes it', async () => {
    const geminiKey = key('pk_g', 'gemini', 'primary');
    vi.mocked(api.providers.get).mockResolvedValue(stateWith([geminiKey]));
    vi.mocked(api.providers.updateKey).mockImplementation(async (_id, patch) => ({
      ok: true, key: { ...geminiKey, ...patch } as ProviderKey, state: stateWith([{ ...geminiKey, ...patch } as ProviderKey]),
    }));
    vi.mocked(api.providers.removeKey).mockResolvedValue({ ok: true, activeId: '', state: stateWith([]) });
    render(<App />);
    await openProviders();

    const card = within(screen.getByRole('list', { name: 'Stored keys' })).getAllByRole('listitem')[0];
    await userEvent.click(within(card).getByRole('button', { name: 'Edit note' }));
    const noteField = within(card).getByLabelText('Note');
    await userEvent.clear(noteField);
    await userEvent.type(noteField, 'renamed');
    await userEvent.click(screen.getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect(api.providers.updateKey).toHaveBeenCalledWith('pk_g', { note: 'renamed' }));

    await userEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(api.providers.updateKey).toHaveBeenCalledWith('pk_g', { enabled: false }));

    vi.stubGlobal('confirm', () => true);
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.providers.removeKey).toHaveBeenCalledWith('pk_g'));
    vi.unstubAllGlobals();
  });

  it('shows the failover badge in the header', async () => {
    vi.mocked(api.health).mockResolvedValue({
      ok: true, service: 'forge', time: '', providers: { jev: 'typesafe', planner: 'gemini', store: 'file' },
      activeProvider: { id: 'pk_g', provider: 'gemini', note: 'primary', model: 'gemini-2.5-flash', origin: 'user' },
      failover: { enabled: true, maxRounds: 10, retryRejected: false, keys: 2, configured: true },
    });
    render(<App />);
    expect(await screen.findByText(/FAILOVER · 10 rounds · 2 keys/i)).toBeInTheDocument();
    expect(screen.getByText('MODEL · gemini · primary')).toBeInTheDocument();
  });
});
