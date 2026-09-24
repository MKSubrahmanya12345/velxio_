import type { ErrorRecord, FlowEntry } from '../types';

export type Level = 'debug' | 'info' | 'success' | 'warn' | 'error';

export const LEVEL_ORDER: Level[] = ['debug', 'info', 'success', 'warn', 'error'];

export function levelOf(ev: FlowEntry): Level {
  const l = ev.level as Level;
  if (l && LEVEL_ORDER.includes(l)) return l;
  if (ev.type === 'error') return 'error';
  if (ev.type === 'part' && ev.stage === 'failed') return 'error';
  if (ev.type === 'part' && ev.stage === 'done') return ev.humanCheckpoint ? 'warn' : 'success';
  if (ev.type === 'provider') return ev.stage === 'fail' || ev.stage === 'round' || ev.stage === 'cooldown' ? 'warn' : 'debug';
  if (ev.type === 'phase') return ev.stage === 'end' ? 'info' : 'debug';
  return 'info';
}

/** Human label for a row in the flow / activity feed — never "undefined". */
export function titleOf(ev: FlowEntry): string {
  const part = ev.part || ev.partId || '';
  switch (ev.type) {
    case 'run':
      return ev.stage === 'start' ? `Run started (${ev.kind || 'build'})` : `Run ${ev.status || 'ended'}`;
    case 'phase':
      return `${ev.stage === 'start' ? '▸' : '✓'} ${ev.name || ev.phase || 'phase'}`;
    case 'decision':
      return `Decision · ${ev.label || '?'}`;
    case 'project':
      return ev.stage === 'decomposed'
        ? `Decomposed into ${ev.parts?.length ?? 0} parts`
        : `Profile · ${ev.profileLabel || ev.profileId || ev.stage || '?'}`;
    case 'batch':
      return ev.stage === 'start'
        ? `Batch ${ev.note || ''} — ${ev.total ?? 0} part(s)`
        : `Batch ${ev.note || ''} — ${ev.ok ?? 0}/${ev.total ?? 0} done`;
    case 'part':
      return `${part || 'part'} · ${ev.stage || ''}`;
    case 'research':
      return part ? `${part} · ${ev.stage || 'research'}` : `research · ${ev.stage || ''}`;
    case 'provider':
      return `${ev.providerLabel || ev.provider || 'provider'} · ${ev.stage || ''}`;
    case 'retry':
      return `Retry ${ev.attempt ?? '?'}/${ev.retries ?? '?'} · ${part}`;
    case 'reconcile':
      return `Integration · ${ev.stage || ''}`;
    case 'human':
      return `${ev.part ? `${ev.part} · ` : ''}checkpoint ${ev.stage || ''}`;
    case 'chat':
      return `${ev.role === 'user' ? 'You' : 'Agent'}`;
    case 'done':
      return `Finished · ${ev.status || '?'}`;
    case 'error':
      return `Failed · ${ev.where || ev.stage || 'run'}`;
    case 'log':
      return ev.message || '(log)';
    case 'result':
      return 'Result';
    default:
      return ev.message || ev.type || 'event';
  }
}

/** Secondary line — the detail you actually need when something looks wrong. */
export function detailOf(ev: FlowEntry): string {
  const bits: string[] = [];
  if (typeof ev.ms === 'number') bits.push(`${ev.ms}ms`);
  if (typeof ev.latencyMs === 'number' && ev.latencyMs !== ev.ms) bits.push(`${ev.latencyMs}ms call`);
  if (ev.tier) bits.push(`tier ${ev.tier}`);
  if (ev.action && ev.action !== ev.tier) bits.push(ev.action);
  if (ev.attempt) bits.push(`attempt ${ev.attempt}${ev.retries ? `/${ev.retries}` : ''}`);
  if (ev.status !== undefined && ev.status !== null && typeof ev.status !== 'object') bits.push(`status ${ev.status}`);
  if (ev.model && !ev.message) bits.push(String(ev.model));
  if (ev.counts) bits.push(`${ev.counts.done}/${ev.counts.total} ok`);
  if (ev.conflicts) bits.push(`${ev.conflicts} conflict(s)`);
  if (ev.patchesApplied) bits.push(`${ev.patchesApplied} patch(es)`);
  if (ev.humanCheckpoint) bits.push('needs your eyes');
  if (ev.note && ev.note !== ev.message) bits.push(ev.note);
  const detail = bits.join(' · ');
  if (detail) return detail;
  if (ev.message && ev.message !== titleOf(ev)) return ev.message;
  return '';
}

export function errorOf(ev: FlowEntry): ErrorRecord | null {
  if (ev.type !== 'error' && !(ev.type === 'part' && ev.stage === 'failed') && ev.type !== 'retry') return null;
  if (ev.error && typeof ev.error === 'object') return ev.error as ErrorRecord;
  if (typeof ev.error === 'string') return { message: ev.error };
  return ev.message ? { message: ev.message } : null;
}

export function isActivity(ev: FlowEntry): boolean {
  return ['run', 'phase', 'decision', 'project', 'batch', 'reconcile', 'done', 'error', 'log'].includes(ev.type);
}

export function isPartTrace(ev: FlowEntry): boolean {
  return ev.type === 'part' || ev.type === 'research' || ev.type === 'retry' || ev.type === 'provider';
}

/** Group key for the flow list — lets the UI collapse a run's noise per part. */
export function groupOf(ev: FlowEntry): string {
  return ev.part || ev.phase || (ev.type === 'provider' ? 'providers' : ev.type);
}

export function formatClock(ev: FlowEntry): string {
  const t = typeof ev.t === 'number' ? ev.t : null;
  if (t !== null) return `+${(t / 1000).toFixed(2)}s`;
  const ts = ev.ts || ev.receivedAt;
  return ts ? new Date(ts).toLocaleTimeString() : '';
}

/** Trim a stack to something a human reads in a panel. */
export function stackLines(err: ErrorRecord | null, max = 6): string[] {
  if (!err?.stack) return [];
  return String(err.stack)
    .split('\n')
    .slice(0, max)
    .map((l) => l.trim());
}
