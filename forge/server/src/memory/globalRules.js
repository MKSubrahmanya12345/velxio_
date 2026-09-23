// Forge — global rule store.
//
// The cross-project rule set the user authors BY HAND (UI or API): add,
// remove, enable, disable — instantly, with NO LLM in the loop. These rules
// are inputs to the JEV pre-turn gate (preturn.js) and to the turn's output
// check. JEV never writes here. The only automated mutation is a
// user-authorized removal decided by the gate (disable(), called by turn.js
// only after a turn passes every check) — it is recorded and reversible via
// update(id, { enabled: true }).
//
// Storage mirrors the provider registry: one JSON file, plain text, written
// atomically (tmp + rename), mutations serialized, git-ignored. A corrupt or
// unreadable file throws instead of being reset.

import fs from 'node:fs';
import path from 'node:path';
import { id } from './model.js';

export const GLOBAL_RULE_KINDS = ['rule', 'preference', 'goal', 'fact'];

const nowIso = () => new Date().toISOString();
const normalizeText = v => String(v || '').trim().slice(0, 2000);
const normalizeNote = v => String(v || '').trim().slice(0, 300);

export function normalizeGlobalRule(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
  const text = normalizeText(raw.text);
  if (!text) return null;
  return {
    id: raw.id,
    text,
    kind: GLOBAL_RULE_KINDS.includes(raw.kind) ? raw.kind : 'rule',
    note: normalizeNote(raw.note),
    enabled: raw.enabled !== false,
    origin: raw.origin === 'gate' ? 'gate' : 'user',
    createdAt: String(raw.createdAt || nowIso()),
    updatedAt: String(raw.updatedAt || raw.createdAt || nowIso()),
    disabledAt: raw.disabledAt ? String(raw.disabledAt) : null,
    disabledBy: raw.disabledBy ? String(raw.disabledBy) : null,
  };
}

export function createGlobalRuleStore(cfg) {
  const file = path.resolve(cfg.globalRules?.dataFile || './data/global-rules.json');
  let rules = null;
  let chain = Promise.resolve();

  const load = () => {
    if (rules) return rules;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') { rules = []; return rules; }
      throw new Error(`Global rules file ${file} is unreadable: ${error.message}. Fix or remove it; nothing was reset.`);
    }
    if (!Array.isArray(raw)) throw new Error(`Global rules file ${file} is not a list; nothing was reset.`);
    rules = raw.map(normalizeGlobalRule).filter(Boolean);
    return rules;
  };

  const persist = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rules, null, 2));
    fs.renameSync(tmp, file);
  };

  // Serialized, error-transparent mutation: every caller gets its own derived
  // promise, and one failure never poisons the next operation.
  const mutate = fn => {
    const run = () => { load(); const result = fn(); persist(); return result; };
    const next = chain.then(run, run);
    chain = next.catch(() => {});
    return next;
  };

  const findOrThrow = id2 => {
    const rule = rules.find(r => r.id === id2);
    if (!rule) throw Object.assign(new Error(`No global rule '${id2}'.`), { status: 404 });
    return rule;
  };

  return {
    file,
    list: () => load().slice(),
    enabled: () => load().filter(r => r.enabled),
    enabledCount: () => load().filter(r => r.enabled).length,
    get: id2 => load().find(r => r.id === id2) || null,

    add: ({ text, kind, note } = {}) => mutate(() => {
      const clean = normalizeText(text);
      if (!clean) throw Object.assign(new Error('Rule text must contain 1–2000 characters.'), { status: 400 });
      if (rules.some(r => r.text.toLowerCase() === clean.toLowerCase())) {
        throw Object.assign(new Error('This exact rule already exists.'), { status: 409 });
      }
      const rule = normalizeGlobalRule({
        id: id('grule'), text: clean,
        kind: GLOBAL_RULE_KINDS.includes(kind) ? kind : 'rule',
        note, enabled: true, createdAt: nowIso(),
      });
      rules.push(rule);
      return rule;
    }),

    update: (id2, patch = {}) => mutate(() => {
      const rule = findOrThrow(id2);
      if (patch.text !== undefined) {
        const clean = normalizeText(patch.text);
        if (!clean) throw Object.assign(new Error('Rule text must contain 1–2000 characters.'), { status: 400 });
        rule.text = clean;
      }
      if (patch.kind !== undefined) {
        if (!GLOBAL_RULE_KINDS.includes(patch.kind)) throw Object.assign(new Error(`kind must be one of: ${GLOBAL_RULE_KINDS.join(', ')}`), { status: 400 });
        rule.kind = patch.kind;
      }
      if (patch.note !== undefined) rule.note = normalizeNote(patch.note);
      if (patch.enabled !== undefined) {
        rule.enabled = Boolean(patch.enabled);
        rule.disabledAt = rule.enabled ? null : nowIso();
        rule.disabledBy = rule.enabled ? null : rule.disabledBy || 'user';
      }
      rule.updatedAt = nowIso();
      return rule;
    }),

    remove: id2 => mutate(() => {
      const at = rules.findIndex(r => r.id === id2);
      if (at === -1) throw Object.assign(new Error(`No global rule '${id2}'.`), { status: 404 });
      const [rule] = rules.splice(at, 1);
      return rule;
    }),

    // The gate's one automated mutation. Disable, never delete: reversible,
    // recorded with who/why, applied only after a turn passes all checks.
    disable: (id2, reason) => mutate(() => {
      const rule = findOrThrow(id2);
      rule.enabled = false;
      rule.disabledAt = nowIso();
      rule.disabledBy = String(reason || 'JEV pre-turn gate').slice(0, 300);
      rule.updatedAt = nowIso();
      return rule;
    }),
  };
}
