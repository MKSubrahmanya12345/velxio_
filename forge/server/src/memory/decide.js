// Forge — JEV decision for the hardware agent.
//
// One System One call. Code applies the answers. No generator drafts a reply,
// and no second model is asked to approve prose. The hardware agent designs
// only after this returns.
//
// State is a structured object. Questions point at `message` and
// `candidates[i].text` — they do not paste the user message into every
// instruction. JEV does not write the clarifying question; code does, from
// the mode it actually returned.

import { makeConversation, makeMessage, nowIso } from '../schema.js';
import { normalizeMemory, activeNotes, id } from './model.js';
import { gateCandidates, preTurnQuestions, applyPreTurn } from './preturn.js';
import { probability } from './decisions.js';

const NEW_RULE = 0.9;

export function decisionQuestions(candidates) {
  return {
    ...preTurnQuestions(candidates),
    new_rule: {
      type: 'noul',
      instructions: 'Does `message` state a standing binding constraint for later work, rather than the task to do now?',
      criteria: {
        true: 'A standing constraint in the user\'s own words (never, only, always, must not) meant to bind later turns.',
        false: 'A build, edit, or question, even if it names parts and pins. The task itself is not a new rule.',
      },
    },
  };
}

export function clarifyQuestion(directive) {
  const rules = (directive?.applicableRules || []).map(rule => rule.text).filter(Boolean).slice(0, 3);
  if (rules.length) {
    return `A decision is needed before designing. Rules in force: ${rules.join(' · ')}. Reply with the one fact that lets the build proceed, or say proceed to use sensible defaults.`;
  }
  return 'A decision is needed before designing: the request cannot be built under the rules in force without one more fact. Reply with that fact, or say proceed.';
}

function rememberStandingRule(memory, message, messageId, score) {
  const text = message.slice(0, 300);
  const note = {
    id: id('note'),
    kind: 'rule',
    domain: 'production',
    text,
    quote: text,
    origin: 'user',
    status: 'active',
    reason: 'Recorded from your message. JEV judged it a standing constraint, not a one-off task.',
    sourceMessageId: messageId,
    createdAt: nowIso(),
    supersedes: [],
    review: { classification: 'rule', support: score, compatible: null, authorized: null },
  };
  memory.notes.push(note);
  memory.revision += 1;
  return note;
}

export async function runDecisionTurn(deps, original, text) {
  const conversation = makeConversation(JSON.parse(JSON.stringify(original)));
  const message = String(text || '').trim();
  if (!message || message.length > 12000) {
    throw Object.assign(new Error('Message must contain 1–12,000 characters.'), { status: 400 });
  }
  const memory = conversation.memory = normalizeMemory(conversation.memory);
  const globalRules = deps.globalRules ? deps.globalRules.enabled() : [];
  const candidates = gateCandidates(globalRules, activeNotes(memory));
  const jevReady = Boolean(deps.cfg?.jev?.apiKey && deps.jev);

  let directive = {
    applicableRules: [],
    mode: 'answer',
    modeTrusted: false,
    ruleChange: null,
    gateSummary: jevReady ? 'no rules in force' : 'JEV unconfigured — designing without a decision call',
    raw: null,
  };
  let jevCalls = 0;
  let storedRule = null;

  if (jevReady) {
    const response = await deps.jev({
      state: {
        operation: 'pre_turn_gate',
        message,
        candidates: candidates.map(rule => ({ id: rule.id, text: rule.text, kind: rule.kind, source: rule.source })),
      },
      questions: decisionQuestions(candidates),
    });
    jevCalls += 1;
    directive = { ...applyPreTurn(response?.answers, candidates), raw: response };
    const clarify = directive.mode === 'clarify_first' && directive.modeTrusted;
    const newRule = probability(response?.answers?.new_rule);
    if (!clarify && newRule !== null && newRule >= NEW_RULE) {
      const userId = 'pending';
      storedRule = rememberStandingRule(memory, message, userId, newRule);
      directive.applicableRules = [
        ...directive.applicableRules,
        { id: storedRule.id, text: storedRule.text, kind: 'rule', source: 'chat', value: newRule, unresolved: false },
      ];
    }
    if (!clarify && directive.ruleChange?.autonomous && directive.ruleChange.targetId) {
      const target = memory.notes.find(note => note.id === directive.ruleChange.targetId && note.status === 'active');
      if (target) {
        target.status = 'superseded';
        target.reason = 'Removed by your authorized message. JEV named this note.';
      } else if (deps.globalRules?.disable) {
        try {
          await deps.globalRules.disable(directive.ruleChange.targetId, 'Removed by the JEV gate: your message explicitly authorized it.');
        } catch {
          // A missing id is not a failed decision. The rule simply stays.
        }
      }
    }
  }

  const clarify = Boolean(jevReady && directive.mode === 'clarify_first' && directive.modeTrusted);
  const question = clarify ? clarifyQuestion(directive) : '';
  const userMessage = makeMessage('user', message);
  if (storedRule) storedRule.sourceMessageId = userMessage.id;
  const assistant = makeMessage('assistant', question || directive.gateSummary || 'Decision recorded.', {
    meta: { decision: true, mode: directive.mode, clarify },
  });
  conversation.messages.push(userMessage, assistant);
  conversation.updatedAt = nowIso();
  conversation.counters.jevCalls = (conversation.counters.jevCalls || 0) + jevCalls;
  conversation.counters.messages = (conversation.counters.messages || 0) + 1;

  return {
    conversation,
    decision: {
      mode: directive.mode,
      modeTrusted: Boolean(directive.modeTrusted),
      clarify,
      question,
      applicableRules: directive.applicableRules,
      gateSummary: directive.gateSummary,
      jevCalls,
      skipped: jevReady ? null : 'jev-unconfigured',
    },
  };
}
