import { z } from 'zod';
import { PARTS, catalog, isPlaceable, normalizeBoardKind } from './catalog';

const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
/**
 * Part ids the catalog knows and the agent may place.
 *
 * A plain string on the wire (the catalog has 157 entries and a zod enum would
 * serialize them all into the JSON schema the model reads), refined against the
 * generated catalog so an unknown or unplaceable part is rejected in the browser
 * with the same rule the backend applies — before anything touches the canvas.
 */
const metadataId = z
  .string()
  .min(1)
  .max(60)
  .refine((value) => Object.prototype.hasOwnProperty.call(PARTS, value), {
    message: 'Unknown component id',
  })
  .refine(isPlaceable, { message: 'This component cannot be placed by the agent' });
const coord = z.number().finite().min(-5000).max(5000);
const endpoint = z.object({ componentId: id, pinName: z.string().min(1).max(16) }).strict();
export const projectSchema = z
  .object({
    board: z
      .object({
        id,
        // Kept optional for old saved responses; workspace conversion fills it
        // from a catalog board id when a model omits it. When present it must
        // be one of the same 30 boards the backend validates — including the
        // short aliases the backend Board model accepts (`uno` →
        // `arduino-uno`). Parse canonicalizes to the catalog id, so an
        // AgentProject always carries a canonical kind like the backend's
        // model_dump(), and the error names the offending value.
        boardKind: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .optional()
          .superRefine((value, ctx) => {
            if (value && !normalizeBoardKind(value)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Unsupported board kind '${value}'. Choose one of the ${Object.keys(catalog.boards).length} Velxio boards.`,
              });
            }
          })
          .transform((value) => (value ? (normalizeBoardKind(value) ?? value) : value)),
        x: coord,
        y: coord,
      })
      .strict()
      .nullable(),
    components: z
      .array(
        z
          .object({
            id,
            metadataId,
            x: coord,
            y: coord,
            properties: z
              .record(z.union([z.string().max(80), z.number().finite(), z.boolean()]))
              .refine((value) => Object.keys(value).length <= 12, {
                message: 'Too many properties',
              }),
          })
          .strict(),
      )
      .max(40),
    wires: z
      .array(
        z
          .object({
            id,
            start: endpoint,
            end: endpoint,
            color: z.string().regex(/^#[\da-fA-F]{6}$/),
          })
          .strict(),
      )
      .max(100),
    files: z
      .array(
        z
          .object({
            name: z
              .string()
              .regex(/^[A-Za-z0-9_-]+\.(ino|h|cpp|c|py)$/)
              .max(80),
            content: z.string().max(40000),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();
export type AgentProject = z.infer<typeof projectSchema>;
export type ChatMessage = { role: 'user' | 'assistant'; content: string };

/** Mirror of backend Expectations: falsifiable live-simulation checks. */
export const expectationsSchema = z
  .object({
    observe_ms: z.number().int().min(500).max(20000),
    pins: z
      .array(
        z
          .object({
            pin: z.string().min(1).max(8),
            expect: z.enum(['toggles', 'high', 'low']),
            min_transitions: z.number().int().min(1).max(10000),
            period_ms: z.tuple([z.number().int(), z.number().int()]).nullable(),
          })
          .strict(),
      )
      .max(12),
    serial: z.array(z.object({ matches: z.string().min(1).max(200) }).strict()).max(6),
    interactions: z
      .array(
        z
          .object({
            // One shape, five kinds. The runtime checks each against the part's
            // declared capabilities (see src/agent/catalog.ts) and the backend
            // rejects a mismatch before the run starts.
            kind: z.enum(['press', 'pot', 'switch', 'stimulus', 'rotary']),
            componentId: id,
            /** Which part pin the input acts on (defaults to the part's primary). */
            pin: z.string().min(1).max(16).nullable().optional(),
            // Optional on the wire (the model may omit what the defaults cover);
            // the runtime applies the same defaults the backend's Interaction
            // model does, so a short payload behaves identically everywhere.
            at_ms: z.number().int().min(0).max(60000).optional(),
            hold_ms: z.number().int().min(10).max(20000).optional(),
            value: z.number().int().min(0).max(1023).optional(),
            /** switch: closed at at_ms (true) or opened (false). */
            closed: z.boolean().optional(),
            /** rotary: detents to turn, positive = clockwise. */
            delta: z.number().int().min(-40).max(40).optional(),
            /** stimulus: sensor model values, e.g. { temperature: 24 }. */
            values: z.record(z.number().finite()).optional(),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export type AgentExpectations = z.infer<typeof expectationsSchema>;

const runId = { run_id: z.string().optional() };

export const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run_started'), run_id: z.string().min(1) }),
  z.object({ type: z.literal('note'), message: z.string(), ...runId }),
  z.object({
    type: z.literal('stage'),
    stage: z.enum(['planning', 'repairing', 'validating', 'compiling', 'research', 'testing', 'verifying']),
    message: z.string(),
    attempt: z.number().optional(),
    ...runId,
  }),
  z.object({ type: z.literal('plan'), plan: z.array(z.string()), summary: z.string(), ...runId }),
  z.object({
    type: z.literal('compile'),
    success: z.boolean(),
    stdout: z.string(),
    stderr: z.string(),
    ...runId,
  }),
  z.object({ type: z.literal('diagnostic'), message: z.string(), ...runId }),
  z.object({ type: z.literal('answer'), summary: z.string(), ...runId }),
  z.object({
    type: z.literal('error'),
    message: z.string(),
    diagnostics: z.string().optional(),
    /** Lets the UI tailor the retry/feedback UX (e.g. malformed_json vs compile). */
    category: z.string().optional(),
    ...runId,
  }),
  z.object({
    type: z.literal('tools'),
    calls: z.array(z.object({ tool: z.string(), ok: z.boolean() }).strict()),
    ...runId,
  }),
  z.object({
    type: z.literal('canvas_update'),
    project: projectSchema,
    label: z.string().optional(),
    ...runId,
  }),
  z.object({
    type: z.literal('result'),
    project: projectSchema,
    hex: z.string().max(1000000).optional(),
    runtime: z.enum(['hex', 'python']).optional(),
    summary: z.string(),
    attempts: z.number(),
    expectations: expectationsSchema.nullable().optional(),
    ...runId,
  }),
  // Forge project memory (JEV-governed). Informational only: the run continues
  // with or without it, so unknown/absent fields must never break the stream.
  // Liveness while a provider call is in flight. Provider calls are streamed,
  // but a long prefill emits no tokens, so the server ticks every few seconds
  // to prove the run is alive and to report how much has streamed in.
  z.object({
    type: z.literal('heartbeat'),
    stage: z.string().optional(),
    attempt: z.number().optional(),
    waited: z.number().optional(),
    chars: z.number().optional(),
    /** Tail of the actual streamed reply — rendered live so the user watches
     *  the code arrive, not just a character counter. */
    text: z.string().optional(),
    provider: z.string().optional(),
    message: z.string(),
    ...runId,
  }),
  // A provider call failed transiently (429/5xx/stall) and is being retried.
  // Surfaced so a rate-limited provider is visible instead of looking hung.
  z.object({
    type: z.literal('retry'),
    provider: z.string().optional(),
    attempt: z.number().optional(),
    of: z.number().optional(),
    message: z.string(),
    ...runId,
  }),
  // Per-call latency trace emitted just before the terminal event.
  z.object({
    type: z.literal('latency_summary'),
    calls: z.array(z.record(z.unknown())).optional(),
    total_ms: z.number().optional(),
    provider_ms: z.number().optional(),
    compile_ms: z.number().optional(),
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    cache_hit_pct: z.number().nullable().optional(),
    ...runId,
  }),
  z.object({
    type: z.literal('forge'),
    status: z.enum(['ok', 'unavailable']),
    summary: z
      .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional()
      .nullable(),
    message: z.string().optional(),
    clarification: z.string().optional(),
    decision: z.string().optional(),
    pending_questions: z.array(z.string()).optional(),
    ...runId,
  }),
]);
export type AgentEvent = z.infer<typeof eventSchema>;

/**
 * One NDJSON line -> event, or null when it is not a shape this client knows.
 *
 * `eventSchema.parse()` THROWS on an unrecognised discriminator, which would
 * abort the entire stream mid-run — a server that grows a new event type (or
 * simply emits `latency_summary`) would take the final result down with it.
 * Unknown events are ignored instead; a garbled line never ends the stream.
 */
function parseEvent(line: string): AgentEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = eventSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  if (typeof raw === 'object' && raw !== null && 'type' in raw) {
    console.debug('[agent] ignoring unknown event type', (raw as { type: unknown }).type);
  }
  return null;
}

/** Handles split UTF-8 characters, split lines, and a final line without LF. */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<AgentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 2000000) throw new Error('Agent response exceeded the size limit.');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = parseEvent(line);
        if (event) yield event;
      }
      if (done) {
        if (buffer.trim()) {
          const event = parseEvent(buffer);
          if (event) yield event;
        }
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Key ordering must not create false conflicts. Array order is meaningful. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
}
