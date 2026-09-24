import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createIndexer } from '../src/services/indexer.js';
import { compactReconcileBundle } from '../src/services/reconcile.js';

test('research index requires the part identity instead of matching shared goal words', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wiregi-index-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const indexer = createIndexer({ db: { dataFile: join(dir, 'projects.json') } });
  indexer.add({
    topic: 'design a weather station with an ESP32 — Environmental Sensor Module (Electronics)',
    partName: 'Environmental Sensor Module',
    domain: 'hardware',
    profileId: 'electronics',
    summary: 'sensor readings and calibration',
  });

  assert.equal(
    indexer.find(
      'design a weather station with an ESP32 — Power Supply (Electronics)',
      2,
      { partName: 'Power Supply', profileId: 'electronics' },
    ),
    null,
  );
  assert.equal(
    indexer.find(
      'another weather station — Environmental Sensor Module',
      2,
      { partName: 'Environmental Sensor Module', profileId: 'electronics' },
    )?.partName,
    'Environmental Sensor Module',
  );
});

test('reconciliation context is bounded while retaining every part identity', () => {
  const parts = Array.from({ length: 6 }, (_, i) => ({
    name: `Part ${i}`,
    domain: 'hardware',
    idea: 'long idea '.repeat(100),
    current: {
      gathered: Array.from({ length: 10 }, (_, j) => ({
        field: `field-${j}`,
        value: 'large value '.repeat(100),
        source: 'datasheet',
      })),
      data: {
        bomRow: 'bom '.repeat(300),
        wiring: 'wiring '.repeat(300),
        config: 'config '.repeat(300),
      },
      understand: { conflicts: ['conflict '.repeat(100)] },
    },
    openQuestions: ['question '.repeat(100)],
  }));

  const compacted = compactReconcileBundle(parts, 8000);
  assert.ok(compacted.chars <= 8000, `bundle is ${compacted.chars} chars`);
  assert.equal(compacted.approxTokens, Math.ceil(compacted.chars / 4));
  for (const part of parts) assert.match(compacted.text, new RegExp(part.name));
});
