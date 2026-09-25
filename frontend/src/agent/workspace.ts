import { useSimulatorStore } from '../store/useSimulatorStore';
import { useEditorStore } from '../store/useEditorStore';
import { useProjectStore } from '../store/useProjectStore';
import {
  PARTS,
  editableProperties,
  isPlaceable,
  normalizeBoardKind,
  runtimePropertiesFor,
  catalog,
} from './catalog';
import { projectSchema, stableStringify, type AgentProject } from './protocol';

export type Snapshot = Parameters<
  ReturnType<typeof useSimulatorStore.getState>['loadProjectState']
>[0];

// Velxio = Cursor: support ALL boards and ALL components; the generated
// catalog below is the single source of truth for that scope.
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
    components: s.components.map((c) => {
      const runtime = runtimePropertiesFor(c.metadataId);
      return {
        ...c,
        properties: Object.fromEntries(
          Object.entries(c.properties).filter(([key]) => !runtime.has(key)),
        ),
      };
    }),
    wires: s.wires,
    activeBoardId: s.activeBoardId,
  });
}

export function fingerprint(snapshot: Snapshot): string {
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
  // Cursor-like: support ALL boards, multiple boards, all language modes
  // Only restriction: boards must be known to catalog
  if (snapshot.boards.length > 3) {
    throw new Error(
      `This agent supports up to 3 boards at once (you have ${snapshot.boards.length}). Remove some boards or open a simpler workspace.`,
    );
  }
  
  // The generated catalog is the one board allowlist shared with the backend.
  // Do not silently turn an imported/overlay board into an Uno: that loses its
  // pinout and is exactly how ESP32 sketches reached the wrong build target.
  // Same leniency as the backend Board model: exact catalog id plus the short
  // aliases (`uno` → `arduino-uno`), whitespace-tolerant.
  const boardCount = Object.keys(catalog.boards).length;
  for (const b of snapshot.boards) {
    if (!normalizeBoardKind(b.boardKind)) {
      throw new Error(
        `The agent supports ${boardCount} Velxio boards, but not '${b.boardKind}'. ` +
        'Choose a board from the supported board picker; your project is unchanged.',
      );
    }
  }
  
  const board = snapshot.boards[0];
  if (board && board.activeFileGroupId && !board.activeFileGroupId.startsWith('group-')) {
    // Allow custom file groups now - Cursor-like flexibility
  }
  
  for (const part of snapshot.components) {
    if (!PARTS[part.metadataId]) {
      throw new Error(
        `The agent does not know the component ${part.metadataId}. Your project is unchanged.`,
      );
    }
    if (PARTS[part.metadataId] && !isPlaceable(part.metadataId)) {
      throw new Error(
        `${PARTS[part.metadataId].name} cannot be placed by the agent. Your project is unchanged.`,
      );
    }
  }
  
  // Extra boards on the canvas travel to the model as board COMPONENTS: the
  // agent protocol carries one `board` field, so boards 2..N are exposed
  // through their placeable catalog part (class 'board') and materialized
  // back into real boards by fromAgentProject. Only kinds the catalog knows
  // as parts round-trip this way; any other secondary board is preserved
  // untouched on apply. Driven purely by the catalog — nothing per-board here.
  const extraBoardParts = snapshot.boards
    .slice(1)
    .filter((b) => PARTS[b.boardKind] && isPlaceable(b.boardKind))
    .map((b) => ({
      id: b.id,
      metadataId: b.boardKind as string,
      x: b.x,
      y: b.y,
      properties: {} as Record<string, string | number | boolean>,
    }));

  const data = projectSchema.safeParse({
    board: board
      ? {
          id: board.id,
          boardKind: normalizeBoardKind(board.boardKind) ?? board.boardKind,
          x: board.x,
          y: board.y,
        }
      : null,
    components: [
      ...extraBoardParts,
      ...snapshot.components.map((c) => ({
        ...c,
        properties: Object.fromEntries(
          Object.entries(c.properties).filter(([key]) =>
            PARTS[c.metadataId] ? editableProperties(c.metadataId).includes(key) : true,
          ),
        ),
      })),
    ],
    wires: snapshot.wires.map((w) => ({
      id: w.id,
      start: { componentId: w.start.componentId, pinName: w.start.pinName },
      end: { componentId: w.end.componentId, pinName: w.end.pinName },
      color: /^#[\da-fA-F]{6}$/.test(w.color) ? w.color : '#4ade80',
    })),
    files: board ? (snapshot.fileGroups[board.activeFileGroupId] ?? []) : [],
  });
  if (!data.success) {
    console.error(data.error);
    throw new Error(
      'This workspace exceeds the agent\'s supported limits or contains unsupported source filenames. Use up to 40 parts, 100 wires, and flat Arduino C/C++ or supported-board Python files.',
    );
  }
  return data.data;
}

export function fromAgentProject(project: AgentProject, previous: Snapshot): Snapshot {
  if (!project.board) throw new Error('The agent returned no board.');
  const rawBoard = project.board;
  const explicitKind = rawBoard.boardKind ? normalizeBoardKind(rawBoard.boardKind) : undefined;
  if (rawBoard.boardKind && !explicitKind) {
    throw new Error(`The agent returned unsupported board ${rawBoard.boardKind}.`);
  }
  const inferredKind = explicitKind ?? normalizeBoardKind(rawBoard.id) ?? 'arduino-uno';
  if (!Object.prototype.hasOwnProperty.call(catalog.boards, inferredKind)) {
    throw new Error(`The agent returned unsupported board ${inferredKind}.`);
  }
  const b = { ...rawBoard, boardKind: inferredKind };
  const oldBoard = previous.boards[0];
  // An agent patch may change the selected board kind, but it must not replace
  // the instance id that existing wires and file groups reference. The backend
  // applies the same continuity rule.
  if (oldBoard && b.id !== oldBoard.id && previous.boards.length === 1) {
    throw new Error('The agent cannot replace the existing board instance; change boardKind in place.');
  }
  const group = oldBoard?.activeFileGroupId ?? `group-${b.id}`;

  // Components whose catalog entry is a board (`class: 'board'`) are extra MCU
  // boards, not canvas parts — `toAgentProject` serializes boards 2..N that way.
  // Split them out so they materialize as real, independently simulated boards
  // (addBoard-equivalent) instead of inert art. Everything below is driven by
  // the catalog's `class`, never by a specific board id.
  const isBoardPart = (metadataId: string) => PARTS[metadataId]?.class === 'board';
  const boardParts = project.components.filter((c) => isBoardPart(c.metadataId));
  const regularParts = project.components.filter((c) => !isBoardPart(c.metadataId));

  const ids = new Set([b.id]);
  for (const c of project.components) {
    if (ids.has(c.id)) throw new Error('Duplicate component ID in agent response.');
    ids.add(c.id);
  }
  for (const wire of project.wires) {
    if (!ids.has(wire.start.componentId) || !ids.has(wire.end.componentId))
      throw new Error('Dangling wire in agent response.');
  }

  const defaultBoardShape = {
    languageMode: 'arduino' as const,
    running: false,
    compiledProgram: null,
    serialOutput: '',
    serialBaudRate: 0,
    serialMonitorOpen: false,
  };
  const mainBoard = {
    ...(oldBoard ?? { boardKind: 'arduino-uno' as const, ...defaultBoardShape }),
    ...b,
    activeFileGroupId: group,
  };
  // Extra boards returned by the agent. Reuse the previous instance when the id
  // matches (keeps its file group / per-board state); otherwise mint a fresh one.
  const extraBoards = boardParts.map((c) => {
    const prev = previous.boards.find((pb) => pb.id === c.id);
    return {
      ...(prev ?? defaultBoardShape),
      id: c.id,
      boardKind: c.metadataId,
      x: c.x,
      y: c.y,
      activeFileGroupId: prev?.activeFileGroupId ?? `group-${c.id}`,
    };
  });
  // Secondary boards the protocol cannot represent (no placeable catalog part
  // for their kind) survive untouched rather than being silently deleted.
  const retained = previous.boards
    .slice(1)
    .filter((pb) => !isBoardPart(pb.boardKind))
    .filter((pb) => !extraBoards.some((eb) => eb.id === pb.id));
  const newBoards = [mainBoard, ...extraBoards, ...retained];

  return {
    boards: newBoards as any,
    fileGroups: { ...previous.fileGroups, [group]: project.files },
    folderGroups: previous.folderGroups,
    components: regularParts.map((c) => ({
      ...c,
      properties: {
        ...Object.fromEntries(
          Object.entries(
            previous.components.find((old) => old.id === c.id && old.metadataId === c.metadataId)
              ?.properties ?? {},
          ).filter(([key]) => PARTS[c.metadataId] ? !editableProperties(c.metadataId).includes(key) : false),
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
  if (!before.boards.length && after.boards.length) {
    const boardKind = after.boards[0]?.boardKind;
    const boardName = (boardKind && catalog.boards[boardKind]?.label) || boardKind || 'board';
    changes.unshift(`+ ${boardName}`);
  }
  // Extra (secondary) boards added or removed — agent-placeable board parts.
  const boardLabelOf = (kind?: string) =>
    (kind && catalog.boards[kind]?.label) || kind || 'board';
  for (const nb of after.boards.slice(1))
    if (!before.boards.some((ob) => ob.id === nb.id))
      changes.push(`+ ${boardLabelOf(nb.boardKind)} (extra board)`);
  for (const ob of before.boards.slice(1))
    if (!after.boards.some((nb) => nb.id === ob.id))
      changes.push(`− ${boardLabelOf(ob.boardKind)} (extra board)`);
  // Also report board changes
  if (before.boards.length && after.boards.length) {
    if (before.boards[0].boardKind !== after.boards[0].boardKind) {
      changes.push(`board: ${before.boards[0].boardKind} → ${after.boards[0].boardKind}`);
    }
  }
  return changes;
}
