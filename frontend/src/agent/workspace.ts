import { useSimulatorStore } from '../store/useSimulatorStore';
import { useEditorStore } from '../store/useEditorStore';
import { useProjectStore } from '../store/useProjectStore';
import { projectSchema, stableStringify, type AgentProject } from './protocol';

export type Snapshot = Parameters<
  ReturnType<typeof useSimulatorStore.getState>['loadProjectState']
>[0];
const editable: Record<string, string[]> = {
  led: ['color', 'label', 'flip', 'rotation'],
  resistor: ['value', 'rotation'],
  pushbutton: ['color', 'label', 'rotation'],
  potentiometer: ['value', 'rotation'],
  buzzer: ['rotation'],
};
const runtimeProperties = new Set(['state', 'pressed', 'hasSignal', 'brightness']);

export function scopeKey(): string {
  const project = useProjectStore.getState();
  return project.currentProject?.id ?? project.currentExampleId ?? window.location.pathname;
}

export function captureWorkspace(): Snapshot {
  const s = useSimulatorStore.getState();
  const e = useEditorStore.getState();
  return structuredClone({
    boards: s.boards.map((b) => ({
      ...b,
      running: false,
      compiledProgram: null,
      compiledSourceHash: undefined,
      compiledUf2: null,
      serialOutput: '',
      serialLink: undefined,
      serialBaudRate: 0,
      serialMonitorOpen: false,
      wifiStatus: undefined,
      bleStatus: undefined,
      hasWifi: undefined,
    })),
    fileGroups: Object.fromEntries(
      Object.entries(e.fileGroups).map(([key, files]) => [
        key,
        files.map(({ name, content }) => ({ name, content })),
      ]),
    ),
    folderGroups: e.folderGroups,
    components: s.components.map((c) => ({
      ...c,
      properties: Object.fromEntries(
        Object.entries(c.properties).filter(
          ([key]) => !runtimeProperties.has(key) && !(c.metadataId === 'led' && key === 'value'),
        ),
      ),
    })),
    wires: s.wires,
    activeBoardId: s.activeBoardId,
  });
}

export function fingerprint(snapshot: Snapshot): string {
  // Wire endpoint coordinates are recalculated after DOM mount; they are not
  // logical edits. Keep routing/layout and all actual design fields in the guard.
  return stableStringify({
    ...snapshot,
    activeBoardId: undefined,
    wires: snapshot.wires.map((w) => ({
      ...w,
      waypoints: w.autoRouted ? undefined : w.waypoints,
      start: { componentId: w.start.componentId, pinName: w.start.pinName },
      end: { componentId: w.end.componentId, pinName: w.end.pinName },
    })),
  });
}

export function assertFresh(expected: string, scope: string) {
  if (scopeKey() !== scope || fingerprint(captureWorkspace()) !== expected) {
    throw new Error(
      'Your workspace changed while the agent was working. Nothing was overwritten. Send the request again to include your latest edits.',
    );
  }
}

export function toAgentProject(snapshot: Snapshot): AgentProject {
  if (
    snapshot.boards.length > 1 ||
    snapshot.boards.some((b) => b.boardKind !== 'arduino-uno' || b.languageMode !== 'arduino')
  ) {
    throw new Error(
      'This agent supports one Arduino Uno in Arduino C++ mode. Open a new Uno workspace; your current project has not been changed.',
    );
  }
  const board = snapshot.boards[0];
  if (board && board.activeFileGroupId !== `group-${board.id}`)
    throw new Error(
      'This project uses a custom file group, which the agent cannot safely edit yet.',
    );
  for (const part of snapshot.components) {
    if (!editable[part.metadataId])
      throw new Error(
        `The agent does not support ${part.metadataId} yet. Your project is unchanged.`,
      );
  }
  const data = projectSchema.safeParse({
    board: board ? { id: board.id, x: board.x, y: board.y } : null,
    components: snapshot.components.map((c) => ({
      ...c,
      properties: Object.fromEntries(
        Object.entries(c.properties).filter(([key]) => editable[c.metadataId].includes(key)),
      ),
    })),
    wires: snapshot.wires.map((w) => ({
      id: w.id,
      start: { componentId: w.start.componentId, pinName: w.start.pinName },
      end: { componentId: w.end.componentId, pinName: w.end.pinName },
      color: /^#[\da-fA-F]{6}$/.test(w.color) ? w.color : '#4ade80',
    })),
    files: board ? (snapshot.fileGroups[board.activeFileGroupId] ?? []) : [],
  });
  if (!data.success)
    throw new Error(
      'This workspace exceeds the agent’s supported limits or contains unsupported source filenames. Use up to 40 parts, 100 wires, and flat Arduino C/C++ files.',
    );
  return data.data;
}

export function fromAgentProject(project: AgentProject, previous: Snapshot): Snapshot {
  if (!project.board) throw new Error('The agent returned no board.');
  const b = project.board;
  const oldBoard = previous.boards[0];
  if (oldBoard && b.id !== oldBoard.id)
    throw new Error('The agent tried to replace the existing board.');
  const group = oldBoard?.activeFileGroupId ?? `group-${b.id}`;
  const ids = new Set([b.id]);
  for (const c of project.components) {
    if (ids.has(c.id)) throw new Error('Duplicate component ID in agent response.');
    ids.add(c.id);
  }
  for (const wire of project.wires) {
    if (!ids.has(wire.start.componentId) || !ids.has(wire.end.componentId))
      throw new Error('Dangling wire in agent response.');
  }
  return {
    boards: [
      {
        ...(oldBoard ?? {
          boardKind: 'arduino-uno' as const,
          languageMode: 'arduino' as const,
          running: false,
          compiledProgram: null,
          serialOutput: '',
          serialBaudRate: 0,
          serialMonitorOpen: false,
        }),
        ...b,
        activeFileGroupId: group,
      },
    ],
    fileGroups: { ...previous.fileGroups, [group]: project.files },
    folderGroups: previous.folderGroups,
    components: project.components.map((c) => ({
      ...c,
      properties: {
        // Preserve only out-of-scope properties. Editable properties are a
        // complete replacement, so omitting a label/rotation resets it.
        ...Object.fromEntries(
          Object.entries(
            previous.components.find((old) => old.id === c.id && old.metadataId === c.metadataId)
              ?.properties ?? {},
          ).filter(([key]) => !editable[c.metadataId].includes(key)),
        ),
        ...c.properties,
      },
    })),
    wires: project.wires.map((w) => {
      const old = previous.wires.find((v) => v.id === w.id);
      const sameEndpoints =
        old &&
        old.start.componentId === w.start.componentId &&
        old.start.pinName === w.start.pinName &&
        old.end.componentId === w.end.componentId &&
        old.end.pinName === w.end.pinName;
      return {
        ...(sameEndpoints ? old : { waypoints: [], autoRouted: true }),
        ...w,
        start: {
          x: sameEndpoints ? old.start.x : 0,
          y: sameEndpoints ? old.start.y : 0,
          ...w.start,
        },
        end: { x: sameEndpoints ? old.end.x : 0, y: sameEndpoints ? old.end.y : 0, ...w.end },
      };
    }),
    activeBoardId: b.id,
  };
}

export function loadWorkspace(snapshot: Snapshot) {
  const sim = useSimulatorStore.getState();
  sim.stopSimulation();
  sim.loadProjectState(structuredClone(snapshot));
  // Canvas-only undo from before the transaction must never mutate the new graph.
  sim.clearHistory();
}

export function describeChanges(before: Snapshot, after: Snapshot): string[] {
  const changes: string[] = [];
  for (const [label, a, b] of [
    ['part', before.components, after.components],
    ['wire', before.wires, after.wires],
  ] as const) {
    const added = b.filter((x) => !a.some((y) => y.id === x.id)).length;
    const removed = a.filter((x) => !b.some((y) => y.id === x.id)).length;
    const updated = b.filter((x) =>
      a.some((y) => y.id === x.id && stableStringify(x) !== stableStringify(y)),
    ).length;
    if (added) changes.push(`+${added} ${label}${added > 1 ? 's' : ''}`);
    if (removed) changes.push(`−${removed} ${label}${removed > 1 ? 's' : ''}`);
    if (updated) changes.push(`${updated} ${label}${updated > 1 ? 's' : ''} updated`);
  }
  const files = (s: Snapshot) => Object.values(s.fileGroups).flat();
  for (const file of files(after))
    if (!files(before).some((f) => f.name === file.name && f.content === file.content))
      changes.push(file.name);
  for (const file of files(before))
    if (!files(after).some((f) => f.name === file.name)) changes.push(`− ${file.name}`);
  if (!before.boards.length && after.boards.length) changes.unshift('+ Arduino Uno');
  return changes;
}
