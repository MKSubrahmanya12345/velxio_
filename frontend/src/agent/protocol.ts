import { z } from 'zod';
import { PARTS, isPlaceable } from './catalog';

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
    board: z.object({ id, x: coord, y: coord }).strict().nullable(),
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
              .regex(/^[A-Za-z0-9_-]+\.(ino|h|cpp|c)$/)
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
    hex: z.string().min(1).max(1000000),
    summary: z.string(),
    attempts: z.number(),
    expectations: expectationsSchema.nullable().optional(),
    ...runId,
  }),
  // Forge project memory (JEV-governed). Informational only: the run continues
  // with or without it, so unknown/absent fields must never break the stream.
  z.object({
    type: z.literal('forge'),
    status: z.enum(['ok', 'unavailable']),
    summary: z
      .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional()
      .nullable(),
    message: z.string().optional(),
    ...runId,
  }),
]);
export type AgentEvent = z.infer<typeof eventSchema>;

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
      for (const line of lines) if (line.trim()) yield eventSchema.parse(JSON.parse(line));
      if (done) {
        if (buffer.trim()) yield eventSchema.parse(JSON.parse(buffer));
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
