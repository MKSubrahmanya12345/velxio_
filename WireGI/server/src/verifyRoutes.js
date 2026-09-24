import { Router } from 'express';

export function createVerifyRouter(deps) {
  const r = Router({ mergeParams: true });

  // GET current ladder + evidence for a project
  r.get('/', async (req, res) => {
    const store = deps.store || deps.projectsStore;
    let proj = await (store?.get?.(req.params.id) || store?.find?.(p => p.id === req.params.id));
    if (!proj) proj = await store?.list?.().then(list => list.find(p => p.id === req.params.id)) || null;
    if (!proj) return res.status(404).json({ error: 'project not found' });
    const ladder = proj.profileId
      ? (require('../services/profiles.js').PROFILES[proj.profileId]?.ladder || ['research','sim','bench-test','human-eyes'])
      : ['research','sim','bench-test','human-eyes'];
    const evidence = proj.state?.parts?.flatMap(p => p.evidence || []) || [];
    // Per-part ladder tracking from part status + evidence
    const partLadders = (proj.state?.parts || []).map(p => ({
      partId: p.id,
      name: p.name,
      profile: p.domain,
      rungs: ladder.map(l => ({ rung: l, done: (p.evidence || []).some(e => e.rung === l), evidence: (p.evidence || []).filter(e => e.rung === l) })),
      humanCheckpoint: p.humanCheckpoint,
      needsInput: p.needsInput,
      status: p.status,
    }));
    res.json({
      projectId: proj.id,
      profileId: proj.profileId,
      profileLabel: proj.profileLabel,
      goal: proj.goal,
      ladder,
      partLadders,
      evidence,
      ideaRevisions: proj.state?.idea?.revisions || [],
      status: proj.status,
    });
  });

  // POST rung update — add evidence to a part's ladder rung
  r.post('/rung', async (req, res) => {
    const store = deps.store || deps.projectsStore;
    let proj = await (store?.get?.(req.params.id) || store?.find?.(p => p.id === req.params.id));
    if (!proj) return res.status(404).json({ error: 'project not found' });
    const { partId, rung, summary, reasoning, source, evidenceType = 'auto' } = req.body || {};
    if (!reasoning) return res.status(400).json({ error: 'reasoning required — brain must explain why' });
    const part = proj.state?.parts?.find(p => p.id === partId || p.name === partId);
    if (!part) return res.status(404).json({ error: 'part not found' });
    if (!part.evidence) part.evidence = [];
    part.evidence.push({ rung, summary, reasoning, source, evidenceType, ts: new Date().toISOString() });
    if (!proj.state.budget) proj.state.budget = { used: 0, max: 10 };
    proj.state.budget.used += 1;
    if (proj.state.budget.used > proj.state.budget.max) return res.status(429).json({ error: 'budget exceeded — stop loop', budget: proj.state.budget });
    part.updatedAt = new Date().toISOString();
    // Mark rung done if evidence present
    if (rung === 'human-eyes' && summary) part.humanCheckpoint = true;
    if (evidenceType === 'human-reject') part.needsInput = true;
    store?.save?.(proj) || (store?.update && store.update(proj));
    res.json({ ok: true, partId: part.id, rung, evidenceLength: part.evidence.length });
  });

  // POST human gate — top rung approval / rejection
  r.post('/gate', async (req, res) => {
    const store = deps.store || deps.projectsStore;
    let proj = await (store?.get?.(req.params.id) || store?.find?.(p => p.id === req.params.id));
    if (!proj) return res.status(404).json({ error: 'project not found' });
    const { decision, reason, partId } = req.body || {}; // decision: 'approve' | 'reject' | 'needs-input'
    const gateRecord = { decision, reason, partId, ts: new Date().toISOString(), by: 'human' };
    if (!proj.state.gate) proj.state.gate = [];
    proj.state.gate.push(gateRecord);
    if (partId) {
      const part = proj.state.parts.find(p => p.id === partId);
      if (part) {
        part.humanInput = part.humanInput || [];
        part.humanInput.push({ decision, reason, ts: gateRecord.ts });
        if (decision === 'approve') { part.verified = true; part.status = 'verified'; part.humanCheckpoint = false; }
        if (decision === 'needs-input') { part.needsInput = true; part.status = 'awaiting_human'; }
        if (decision === 'reject') { part.status = 'failed'; part.error = reason || 'rejected at human gate'; }
        part.updatedAt = new Date().toISOString();
      }
    }
    proj.updatedAt = new Date().toISOString();
    store?.save?.(proj) || (store?.update && store.update(proj));
    res.json({ ok: true, gate: gateRecord, projectStatus: proj.status });
  });

  // POST idea revision — living document update
  r.post('/idea', (req, res) => {
    const store = deps.store || deps.projectsStore;
    const proj = store?.get?.(req.params.id) || store?.find?.(p => p.id === req.params.id);
    if (!proj) return res.status(404).json({ error: 'project not found' });
    const { revision, note, changedFields = [] } = req.body || {};
    if (!proj.state.idea.revisions) proj.state.idea.revisions = [];
    proj.state.idea.revisions.push({ text: revision || note, changedFields, ts: new Date().toISOString() });
    if (revision) proj.goal = revision; // update living goal if provided
    proj.updatedAt = new Date().toISOString();
    store?.save?.(proj) || (store?.update && store.update(proj));
    res.json({ ok: true, revisions: proj.state.idea.revisions.length });
  });

  r.get('/fusion', async (req, res) => {
    const store = deps.store || deps.projectsStore;
    let proj = await (store?.get?.(req.params.id) || store?.find?.(p => p.id === req.params.id));
    if (!proj) return res.status(404).json({ error: 'project not found' });
    let forgeNotes = [];
    try {
      const { extractForgeMemory } = require('./forge-export/extract.js');
      forgeNotes = extractForgeMemory();
    } catch {}
    res.json({
      fusion: true,
      wiregiState: { id: proj.id, status: proj.status, profile: proj.profileId },
      forgeMemory: forgeNotes.slice(0, 10),
      shared: true,
      message: 'One memory: Forge ideas + WireGI build state',
    });
  });


  // CHALLENGE endpoint — human disputes evidence, feeds back into reasoning
  r.post('/challenge', async (req, res) => {
    const store = deps.store || deps.projectsStore;
    let proj = await (store?.get?.(req.params.id) || store?.find?.(p => p.id === req.params.id));
    if (!proj) return res.status(404).json({ error: 'project not found' });
    const { partId, rung, reason, challengeType = 'evidence' } = req.body || {};
    const part = proj.state?.parts?.find(p => p.id === partId || p.name === partId);
    if (!part) return res.status(404).json({ error: 'part not found' });
    if (!part.challenges) part.challenges = [];
    part.challenges.push({ rung, reason, challengeType, ts: new Date().toISOString(), by: 'human' });
    part.needsInput = true;
    part.status = 'awaiting_human';
    proj.updatedAt = new Date().toISOString();
    store?.save?.(proj);
    res.json({ ok: true, challengeRecorded: true, partStatus: part.status });
  });

  return r;
}
