import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { api } from '../api';
import { ChatView } from '../components/ChatView';
import { ConversationList } from '../components/ConversationList';
import { conversation, deferred, humanTool, result } from './fixtures';
import type { Conversation, MessageResult } from '../types';

vi.mock('../api', () => ({ api: {
  health: vi.fn(), list: vi.fn(), create: vi.fn(), get: vi.fn(), message: vi.fn(), remove: vi.fn(),
} }));

beforeEach(() => {
  vi.mocked(api.list).mockResolvedValue([conversation('a'), conversation('b')]);
  vi.mocked(api.health).mockResolvedValue({ ok: true, service: 'forge', time: '', providers: { jev: 'mock', planner: 'mock', store: 'file' } });
  vi.mocked(api.get).mockImplementation(async id => conversation(id));
});

async function openBuild(id: string) {
  await userEvent.click(await screen.findByRole('button', { name: new RegExp(`^Build ${id}`) }));
  await screen.findByText(`Plan for Build ${id}`);
}

describe('workspace request ordering', () => {
  it('keeps the most recently selected build when fetches resolve out of order', async () => {
    const first = deferred<Conversation>();
    vi.mocked(api.get).mockImplementation(id => id === 'a' ? first.promise : Promise.resolve(conversation(id)));
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /^Build a/ }));
    await openBuild('b');
    await act(async () => first.resolve(conversation('a')));
    expect(screen.getByText('Plan for Build b')).toBeInTheDocument();
    expect(screen.queryByText('Plan for Build a')).not.toBeInTheDocument();
  });

  it('does not jump back when an old build finishes sending', async () => {
    const send = deferred<MessageResult>();
    vi.mocked(api.message).mockReturnValue(send.promise);
    render(<App />);
    await openBuild('a');
    await userEvent.type(screen.getByRole('textbox', { name: 'Message Forge' }), 'Measured 5V');
    await userEvent.click(screen.getByRole('button', { name: 'Send →' }));
    await openBuild('b');
    await act(async () => send.resolve(result(conversation('a'))));
    expect(screen.getByText('Plan for Build b')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message Forge' })).toHaveValue('');
  });

  it('does not overwrite a completed send with an older reopen snapshot', async () => {
    const send = deferred<MessageResult>();
    const reopen = deferred<Conversation>();
    vi.mocked(api.message).mockReturnValue(send.promise);
    render(<App />);
    await openBuild('a');
    await userEvent.type(screen.getByRole('textbox', { name: 'Message Forge' }), 'Measured 5V');
    await userEvent.click(screen.getByRole('button', { name: 'Send →' }));
    await openBuild('b');
    vi.mocked(api.get).mockReturnValueOnce(reopen.promise);
    await userEvent.click(screen.getByRole('button', { name: /^Build a/ }));
    const updated = conversation('a');
    updated.messages[0].content = 'Latest verified result';
    await act(async () => send.resolve(result(updated)));
    expect(screen.getByText('Latest verified result')).toBeInTheDocument();
    await act(async () => reopen.resolve(conversation('a')));
    expect(screen.getByText('Latest verified result')).toBeInTheDocument();
    expect(screen.queryByText('Plan for Build a')).not.toBeInTheDocument();
  });

  it('guards duplicate creates and keeps the goal when creation fails', async () => {
    const create = deferred<MessageResult>();
    vi.mocked(api.create).mockReturnValue(create.promise);
    render(<App />);
    const input = screen.getByRole('textbox', { name: 'Describe your build' });
    await userEvent.type(input, 'Build a desk lamp');
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Starting your project…' })).toBeDisabled();
    await act(async () => create.reject(new Error('Planner unavailable')));
    expect(screen.getByRole('alert')).toHaveTextContent('Planner unavailable');
    expect(input).toHaveValue('Build a desk lamp');
    expect(screen.getByRole('button', { name: 'Start project →' })).toBeEnabled();
  });

  it('adds a completed plan to history without interrupting navigation', async () => {
    const create = deferred<MessageResult>();
    vi.mocked(api.create).mockReturnValue(create.promise);
    render(<App />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Describe your build' }), 'Build a robot');
    await userEvent.click(screen.getByRole('button', { name: 'Start project →' }));
    await openBuild('b');
    await act(async () => create.resolve(result(conversation('robot'))));
    expect(screen.getByRole('button', { name: /^Build robot/ })).toBeInTheDocument();
    expect(screen.getByText('Plan for Build b')).toBeInTheDocument();
  });

  it('shows delete failures without losing history', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(api.remove).mockRejectedValue(new Error('Storage unavailable'));
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Build a' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not delete conversation');
    expect(screen.getByRole('button', { name: /^Build a/ })).toBeInTheDocument();
  });

  it('offers reconnect and recovers from an initial connection failure', async () => {
    vi.mocked(api.list).mockRejectedValueOnce(new Error('Offline'));
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
    await screen.findByRole('button', { name: /^Build a/ });
    expect(screen.queryByText(/Could not connect to Forge/)).not.toBeInTheDocument();
  });
});

describe('chat composer and rendering', () => {
  it('keeps a failed message editable for retry, without duplicate sends', async () => {
    const send = deferred<MessageResult>();
    vi.mocked(api.message).mockReturnValue(send.promise);
    render(<ChatView conversation={conversation('a')} onUpdate={vi.fn()} onBack={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: 'Message Forge' });
    await userEvent.type(input, 'The measured voltage is 4.9V');
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    expect(api.message).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status', { name: 'Message processing' })).toHaveTextContent('Forge is reviewing');
    await act(async () => send.reject(new Error('Connection lost')));
    expect(input).toHaveValue('The measured voltage is 4.9V');
    expect(input).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Your draft is still here');
    vi.mocked(api.message).mockResolvedValue(result(conversation('a')));
    await userEvent.click(screen.getByRole('button', { name: 'Send →' }));
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('prepares reports without inventing completion or replacing an existing draft', async () => {
    const c = conversation('a');
    c.pendingHumanTools = [humanTool];
    render(<ChatView conversation={c} onUpdate={vi.fn()} onBack={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Report progress' }));
    const input = screen.getByRole('textbox', { name: 'Message Forge' });
    expect(input).toHaveFocus();
    expect(input).toHaveValue('I completed the step. Here is what I checked: ');
    expect(api.message).not.toHaveBeenCalled();
    await userEvent.type(input, '5V output');
    await userEvent.click(screen.getByRole('button', { name: 'Report a problem' }));
    expect(input).toHaveValue('I completed the step. Here is what I checked: 5V output');
  });

  it('renders Markdown while ignoring raw HTML and unsafe link protocols', () => {
    const c = conversation('a');
    c.messages[0].content = '## Assembly\n\n**Check power**\n\n- Use a meter\n\n```cpp\nsetup();\n```\n\n<script>alert(1)</script>\n\n[bad](javascript:alert)';
    const { container } = render(<ChatView conversation={c} onUpdate={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Assembly' })).toBeInTheDocument();
    expect(screen.getByText('Check power').tagName).toBe('STRONG');
    expect(screen.getByText('Use a meter').tagName).toBe('LI');
    expect(screen.getByText('setup();').tagName).toBe('CODE');
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText('bad')).not.toHaveAttribute('href', 'javascript:alert');
  });
});

it('filters history case-insensitively and shows an empty search state', async () => {
  render(<ConversationList conversations={[conversation('a', 'Desk lamp'), conversation('b', 'Robot')]} currentId="a" onSelect={vi.fn()} onDelete={vi.fn()} />);
  const input = screen.getByRole('searchbox', { name: /Your builds/ });
  await userEvent.type(input, 'LAMP');
  expect(screen.getByRole('button', { name: /^Desk lamp/ })).toHaveAttribute('aria-current', 'page');
  expect(screen.queryByRole('button', { name: /^Robot/ })).not.toBeInTheDocument();
  await userEvent.clear(input);
  await userEvent.type(input, 'missing');
  expect(screen.getByText('No matching builds')).toBeInTheDocument();
});
