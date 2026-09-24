import type { Project } from '../types';
import DecisionLog from './DecisionLog';
import ResearchLog from './ResearchLog';
import ReconcileLog from './ReconcileLog';

/**
 * The Evidence tab: why you should believe the build.
 *
 * Decisions, research sources and cross-part integration used to be three
 * separate tabs — which meant three tabs that each said "none yet" on a fresh
 * project, and three clicks to answer one question. They are three views of the
 * same thing ("how was this conclusion reached?"), so they are now one scroll,
 * ordered by how much they change what you do next:
 *
 *   1. Integration — parts that contradict each other. Fix these first.
 *   2. Decisions   — what the typed layer chose, and when it fell back to the LLM.
 *   3. Research    — which engine and how many sources each part drew on.
 *
 * A section with nothing in it simply does not render.
 */
export default function EvidencePanel({ project }: { project: Project | null }) {
  const decisions = project?.state.decisions || [];
  const research = project?.state.researchLog || [];
  const reconciliations = (project?.state.reconciliations || []).filter((r) => !r.skipped);

  const blocking = reconciliations.reduce(
    (n, p) => n + (p.conflicts || []).filter((c) => c.severity === 'blocking').length,
    0,
  );

  if (!decisions.length && !research.length && !reconciliations.length) {
    return (
      <div className="panel">
        <h3>Evidence</h3>
        <p className="muted small">
          Nothing recorded yet. Once the run starts, this tab fills with the integration pass (do the parts agree?),
          every typed decision, and which sources each part drew on.
        </p>
      </div>
    );
  }

  return (
    <div className="evidence">
      {reconciliations.length > 0 && (
        <section>
          {blocking > 0 && (
            <div className="banner warn">
              {blocking} blocking conflict{blocking === 1 ? '' : 's'} between parts — resolve these before you build.
            </div>
          )}
          <ReconcileLog passes={reconciliations} />
        </section>
      )}
      {decisions.length > 0 && <DecisionLog decisions={decisions} />}
      {research.length > 0 && <ResearchLog log={research} />}
    </div>
  );
}
