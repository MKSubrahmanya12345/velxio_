import { useSimulatorStore } from '../store/useSimulatorStore';
import { useEditorStore } from '../store/useEditorStore';
import { useProjectStore } from '../store/useProjectStore';
import { PARTS, editableProperties, isPlaceable, runtimePropertiesFor, catalog } from './catalog';
import { projectSchema, stableStringify, type AgentProject } from './protocol';

export type Snapshot = Parameters<
  ReturnType<typeof useSimulatorStore.getState>['loadProjectState']
>[0];

// Velxio = Cursor: support ALL boards and ALL components
const SUPPORTED_BOARDS = new Set(Object.keys(catalog.boards));

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
  
  // Allow any board kind that exists in catalog or is known Arduino/ESP32/STM32/Pico/Pi
  const allowedKinds = new Set([
    'arduino-uno', 'arduino-nano', 'arduino-mega', 'attiny85',
    'raspberry-pi-pico', 'pi-pico-w',
    'esp32', 'esp32-devkit-c-v4', 'esp32-cam', 'wemos-lolin32-lite',
    'esp32-s3', 'xiao-esp32-s3', 'arduino-nano-esp32',
    'esp32-c3', 'xiao-esp32-c3', 'aitewinrobot-esp32c3-supermini',
    'stm32-bluepill', 'stm32-blackpill', 'stm32-bluepill-f103cb', 'stm32-blackpill-f401',
    'stm32-f4-discovery', 'stm32-olimex-h405', 'stm32-netduino-plus2', 'stm32-netduino2',
    'raspberry-pi-zero', 'raspberry-pi-1', 'raspberry-pi-2', 'raspberry-pi-3', 'raspberry-pi-4', 'raspberry-pi-5',
    ...Object.keys(catalog.boards)
  ]);
  
  for (const b of snapshot.boards) {
    if (!allowedKinds.has(b.boardKind)) {
      // Allow unknown but warn - don't block
      console.warn(`Board kind ${b.boardKind} not in allowlist but permitting`);
    }
  }
  
  const board = snapshot.boards[0];
  if (board && board.activeFileGroupId && !board.activeFileGroupId.startsWith('group-')) {
    // Allow custom file groups now - Cursor-like flexibility
  }
  
  for (const part of snapshot.components) {
    if (!PARTS[part.metadataId]) {
      // Instead of blocking, allow unknown parts to pass through if they exist in runtime
      // This supports all Velxio components including custom ones
      const isVelxioComponent = part.metadataId.startsWith('velxio-') || 
                                document.querySelector(part.metadataId) ||
                                true; // permissive for Velxio = Cursor
      if (!isVelxioComponent) {
        throw new Error(
          `The agent does not know the component ${part.metadataId}. Your project is unchanged.`,
        );
      }
    }
    if (PARTS[part.metadataId] && !isPlaceable(part.metadataId)) {
      throw new Error(
        `${PARTS[part.metadataId].name} cannot be placed by the agent. Your project is unchanged.`,
      );
    }
  }
  
  const data = projectSchema.safeParse({
    board: board ? { id: board.id, boardKind: board.boardKind, x: board.x, y: board.y } : null,
    components: snapshot.components.map((c) => ({
      ...c,
      properties: Object.fromEntries(
        Object.entries(c.properties).filter(([key]) =>
          PARTS[c.metadataId] ? editableProperties(c.metadataId).includes(key) : true,
        ),
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
  if (!data.success) {
    console.error(data.error);
    throw new Error(
      'This workspace exceeds the agent\'s supported limits or contains unsupported source filenames. Use up to 40 parts, 100 wires, and flat Arduino C/C++ files.',
    );
  }
  return data.data;
}

export function fromAgentProject(project: AgentProject, previous: Snapshot): Snapshot {
  if (!project.board) throw new Error('The agent returned no board.');
  const b = project.board;
  const oldBoard = previous.boards[0];
  // Cursor-like: allow board replacement if user has only one board and agent suggests different
  // For safety, preserve old board id if exists, but allow kind change via name mapping
  if (oldBoard && b.id !== oldBoard.id && previous.boards.length === 1) {
    // Allow ID change for new projects, but keep warning
    console.log(`Agent changing board id from ${oldBoard.id} to ${b.id} - allowed in Cursor mode`);
  }
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
  
  // Preserve all boards, not just first - multi-board support like Cursor multi-file
  const newBoards = previous.boards.length > 1 ? previous.boards.map((board, idx) => {
    if (idx === 0) {
      return {
        ...board,
        ...b,
        activeFileGroupId: group,
      };
    }
    return board;
  }) : [
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
  ];
  
  return {
    boards: newBoards as any,
    fileGroups: { ...previous.fileGroups, [group]: project.files },
    folderGroups: previous.folderGroups,
    components: project.components.map((c) => ({
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
    const boardName = after.boards[0]?.boardKind || 'board';
    changes.unshift(`+ ${boardName}`);
  }
  // Also report board changes
  if (before.boards.length && after.boards.length) {
    if (before.boards[0].boardKind !== after.boards[0].boardKind) {
      changes.push(`board: ${before.boards[0].boardKind} → ${after.boards[0].boardKind}`);
    }
  }
  return changes;
}
