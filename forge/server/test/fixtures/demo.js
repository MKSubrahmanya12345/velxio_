// Offline demonstration only. These bounded heuristics are NOT the live AI path.
// Arbitrary semantic judgments require a configured generation model + JEV.
const solo = text => /only (?:me|myself|one|a single)|(?:just|single).*(?:me|person|guy)|alone|no (?:crew|other people)/i.test(text);
const rule = text => /\bonly\b|\bmust\b|\bnever\b|\bno\b|\bcannot\b|\bcan't\b|\brule\b|\balone\b|\bsingle\b/i.test(text);
const explicitChange = message => /^replace (?:rule|note) note_[\w-]+:/i.test(message.trim());
const live = memory => memory.notes.filter(n => n.status === 'active');
const domainOf = text => /character|story|plot|scene|supernatural|ghost|monster|timeline|past self|future self|haunt|demon|voic/i.test(text)
  ? 'fiction'
  : /crew|actor|camera|equipment|budget|shoot|location|schedule|phone|monitor|only me|solo/i.test(text) ? 'production' : 'unknown';

export function createDemoReasoner() {
  return {
    async propose({ message, memory }) {
      const replacement = message.match(/^replace (?:rule|note) (note_[\w-]+):\s*([\s\S]+)/i);
      if (replacement) return { notes: [{ kind: memory.notes.find(n => n.id === replacement[1])?.kind || 'rule', domain: domainOf(replacement[2]), text: replacement[2], quote: replacement[2], supersedes: [replacement[1]] }] };
      const notes = [];
      const clauses = message.split(/[.!?\n]+/).map(s => s.trim()).filter(Boolean);
      for (const text of clauses.slice(0, 8)) {
        if (/\b(wanna|want to|make|build|create|organize|write|launch)\b/i.test(text) && !live(memory).some(n => n.kind === 'goal')) notes.push({ kind: 'goal', domain: domainOf(text), text, quote: text });
        if (rule(text)) notes.push({ kind: 'rule', domain: domainOf(text), text, quote: text });
        else if (/\bi (?:have|own|can use)|my (?:budget|equipment|location)/i.test(text)) notes.push({ kind: 'fact', domain: domainOf(text), text, quote: text });
        else if (/\bi (?:prefer|like|would rather)/i.test(text)) notes.push({ kind: 'preference', domain: domainOf(text), text, quote: text });
      }
      if (solo(message)) notes.push({ kind: 'assumption', domain: 'production', text: 'Production methods should be operable by one person.', quote: '' });
      if (/film|movie/i.test(message)) notes.push({ kind: 'suggestion', domain: 'production', text: 'Consider a self-recorded scene where the threat is suggested through sound and framing.', quote: '' });
      if (/brother|friend|helper|crew/i.test(message) && !rule(message) && !explicitChange(message)) {
        const previous = live(memory).find(n => n.kind === 'rule' && solo(n.text));
        if (previous) notes.push({ kind: 'rule', domain: domainOf(message), text: message, quote: message, supersedes: [previous.id] });
      }
      return { notes: notes.slice(0, 8) };
    },
    async respond({ memory, message, history, repair }) {
      const notes = live(memory);
      const rules = notes.filter(n => n.kind === 'rule');
      const pending = memory.notes.filter(n => n.status === 'pending');
      const context = [...notes.map(n => n.text), ...history.map(m => m.content)].join(' ');
      const prefix = '**Offline demo** · Notes and checks use deterministic examples, not live AI.\n\n';
      if (pending.length) return { content: prefix + `There is a possible change to clarify before I use it:\n\n> ${pending.at(-1).text}\n\nYour existing rules are still active. Is this a scoped exception, or should it replace an earlier rule? Use **Change this note** in Project memory to state the complete replacement, including any limits.` };
      if (/film|movie/i.test(context) && notes.some(n => n.kind === 'rule' && solo(n.text))) {
        return { content: prefix + `## A film you can make yourself\n\nYour one-person requirement stays in force for both performance and production.\n\n**A possible premise—not a new rule:** You record yourself sleeping. On playback, you sit up and speak to the camera, but remember none of it. Tonight, you decide to stay awake.\n\n- Use fixed, self-operated shots.\n- Build tension through silence, off-screen sound, and changes between cuts.\n- Test one short scene before committing to a full shoot.\n\n${/phone|camera/i.test(context) ? 'Your stated equipment is part of the project context. What space can you film in, and how long should the finished film be?' : 'What can you record with, and where can you film?'}\n\n${rules.length > 1 ? `Other active requirements remain in memory:\n${rules.filter(n => !solo(n.text)).map(n => `- ${n.text}`).join('\n')}` : ''}` };
      }
      return { content: prefix + `${repair ? 'I revised the draft after the rule check.\n\n' : ''}## Working from your project memory\n\n${rules.length ? `I’m keeping these requirements active:\n${rules.map(n => `- ${n.text}`).join('\n')}\n\n` : ''}${notes.find(n => n.kind === 'goal') ? `**Outcome:** ${notes.find(n => n.kind === 'goal').text}\n\n` : ''}What would be the most useful concrete output next, and what resources do you already have?\n\nConnect a generation provider and TypeSafe JEV for open-ended extraction, contextual answers, and semantic rule checks. The offline demonstration cannot reason reliably about arbitrary requests.` };
    },
  };
}

export function demoMemoryAnswers(ctx, questions) {
  const answers = {};
  for (const [key, question] of Object.entries(questions)) {
    const index = Number(key.split('_').at(-1));
    const candidate = ctx.proposals?.[index];
    if (ctx.operation === 'memory_review') {
      const supported = !!candidate?.quote && ctx.message.includes(candidate.quote);
      if (key.startsWith('kind_')) answers[key] = { type: 'choice', choice: candidate?.kind || 'question', confidence: .95 };
      else if (key.startsWith('domain_')) answers[key] = { type: 'choice', choice: candidate?.domain && candidate.domain !== 'unknown' ? candidate.domain : domainOf(`${candidate?.text || ''} ${ctx.message}`), confidence: .9 };
      else if (key.startsWith('conflicts_with_')) answers[key] = { type: 'choice', choice: 'none', confidence: .95 };
      else if (key.startsWith('reconcile_')) answers[key] = { type: 'choice', choice: 'open', confidence: .9 };
      else if (key.startsWith('support_')) answers[key] = { type: 'noul', noul: supported ? .98 : .1 };
      else if (key.startsWith('change_')) answers[key] = { type: 'noul', noul: !candidate?.supersedes?.length || explicitChange(ctx.message) ? .98 : .1 };
      else answers[key] = { type: 'noul', noul: .95 };
    } else if (ctx.operation === 'output_review') {
      if (key === 'disposition') answers[key] = { type: 'choice', choice: 'deliver', confidence: .95 };
      else if (question.type === 'score') answers[key] = { type: 'score', score: 2, confidence: .95 };
      else {
        const violation = solo(ctx.notes[index]?.text || '') && /(?:ask|hire|have|get) (?:a|your|another|an) (?:friend|actor|crew|camera operator|assistant)|second actor/i.test(ctx.draft);
        // Demo intentionally only checks its documented solo-production example.
        const supported = solo(ctx.notes[index]?.text || '') || ['goal', 'fact', 'preference'].includes(ctx.notes[index]?.kind) || ctx.draft.includes(ctx.notes[index]?.text);
        answers[key] = { type: 'noul', noul: violation ? .02 : supported ? .96 : .5 };
      }
    }
  }
  return { provider: 'mock', model: 'jev-memory-demo', answers };
}
