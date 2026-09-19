/** Fixture model/compiler responses + REAL browser simulator. Start Vite, then:
 * npm install --no-save playwright && npx playwright install chromium
 * node scripts/agent-browser-smoke.mjs
 * Optional: CHROMIUM_PATH, AGENT_TEST_URL, AGENT_SCREENSHOT_DIR.
 */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const hex = await fs.readFile(
  new URL('../../test/test_circuit/fixtures/blink.hex', import.meta.url),
  'utf8',
);
const design = {
  board: { id: 'uno', x: 100, y: 150 },
  components: [
    { id: 'led1', metadataId: 'led', x: 500, y: 140, properties: { color: 'red' } },
    { id: 'r1', metadataId: 'resistor', x: 480, y: 270, properties: { value: '330' } },
  ],
  wires: [
    {
      id: 'w1',
      start: { componentId: 'uno', pinName: '13' },
      end: { componentId: 'r1', pinName: '1' },
      color: '#44ff88',
    },
    {
      id: 'w2',
      start: { componentId: 'r1', pinName: '2' },
      end: { componentId: 'led1', pinName: 'A' },
      color: '#44ff88',
    },
    {
      id: 'w3',
      start: { componentId: 'led1', pinName: 'C' },
      end: { componentId: 'uno', pinName: 'GND.1' },
      color: '#222222',
    },
  ],
  files: [
    {
      name: 'sketch.ino',
      content:
        '// Fixture: blink D13\nvoid setup(){pinMode(13,OUTPUT);}\nvoid loop(){digitalWrite(13,HIGH);delay(1000);digitalWrite(13,LOW);delay(1000);}',
    },
  ],
};
let requests = 0;
await page.route('**/api/agent/status', (route) =>
  route.fulfill({
    json: { configured: true, requires_token: false, model: 'Fixture provider', scope: 'Uno' },
  }),
);
await page.route('**/api/news/**', (route) => route.fulfill({ json: {} }));
await page.route('**/api/agent/runs', async (route) => {
  const request = route.request().postDataJSON();
  requests++;
  const candidate = requests === 1 ? design : structuredClone(request.project);
  if (requests > 1) {
    assert.match(candidate.files[0].content, /manual comment/);
    candidate.components.find((c) => c.id === 'led1').properties.color = 'green';
  }
  const events = [
    { type: 'stage', stage: 'planning', message: 'Designing fixture circuit', attempt: 1 },
    {
      type: 'plan',
      plan: ['Wire an LED with a series resistor', 'Compile Uno firmware'],
      summary: 'Test fixture',
    },
    { type: 'compile', success: true, stdout: 'Fixture compiler output', stderr: '' },
    {
      type: 'result',
      project: candidate,
      hex,
      summary: 'Fixture circuit ready. Click the LED to inspect it.',
      attempts: 1,
    },
  ];
  await route.fulfill({
    contentType: 'application/x-ndjson',
    body: events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  });
});
try {
  await page.goto(`${process.env.AGENT_TEST_URL ?? 'http://localhost:5173'}/editor?agent-smoke=1`);
  await page.waitForSelector('.agent-panel');
  const catalog = JSON.parse(
    await fs.readFile(new URL('../../backend/app/agent/catalog.json', import.meta.url), 'utf8'),
  );
  const invalidPins = await page.evaluate((catalog) => {
    const invalid = [];
    for (const [kind, pins] of Object.entries(catalog)) {
      const element = document.createElement(`wokwi-${kind}`);
      const actual = new Set(element.pinInfo.map((pin) => pin.name));
      for (const pin of pins)
        if (!actual.has(pin) && !(kind === 'arduino-uno' && pin === 'GND' && actual.has('GND.1')))
          invalid.push(`${kind}:${pin}`);
    }
    return invalid;
  }, catalog);
  assert.deepEqual(invalidPins, [], 'Backend catalog must match real component pins');

  await page.evaluate(async () => {
    const { useSimulatorStore } = await import('/src/store/useSimulatorStore.ts');
    useSimulatorStore.getState().loadProjectState({
      boards: [],
      components: [],
      wires: [],
      fileGroups: {},
      activeBoardId: null,
    });
  });
  await page.getByLabel('Describe a circuit or request a change').fill('Build a blinking LED');
  await page.getByLabel('Send prompt', { exact: true }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('.agent-messages')
        ?.textContent.includes('Behaviour is not automatically verified'),
    null,
    { timeout: 30000 },
  );
  const first = await page.evaluate(async () => {
    const { useSimulatorStore } = await import('/src/store/useSimulatorStore.ts');
    const s = useSimulatorStore.getState();
    return {
      running: s.running,
      boards: s.boards.length,
      parts: s.components.length,
      wires: s.wires.length,
    };
  });
  assert.deepEqual(first, { running: true, boards: 1, parts: 2, wires: 3 });
  // Observe actual LED transitions, rather than trusting the running flag.
  for (const state of [true, false])
    await page.waitForFunction(
      async (state) => {
        const { useSimulatorStore } = await import('/src/store/useSimulatorStore.ts');
        return (
          useSimulatorStore.getState().components.find((c) => c.id === 'led1')?.properties.state ===
          state
        );
      },
      state,
      { timeout: 10000 },
    );
  await page.evaluate(async () => {
    const { useEditorStore } = await import('/src/store/useEditorStore.ts');
    const e = useEditorStore.getState();
    const file = e.files[0];
    e.setFileContent(file.id, '// manual comment\n' + file.content);
  });
  await page
    .getByLabel('Describe a circuit or request a change')
    .fill('Make the LED green and preserve my comment');
  await page.getByLabel('Send prompt', { exact: true }).click();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.agent-message.assistant')].filter((e) =>
        e.textContent.includes('Behaviour is not automatically verified'),
      ).length === 2,
  );
  assert.equal(
    await page.evaluate(
      async () =>
        (await import('/src/store/useSimulatorStore.ts')).useSimulatorStore
          .getState()
          .components.find((c) => c.id === 'led1').properties.color,
    ),
    'green',
  );
  await page.getByRole('tab', { name: /CHECKPOINTS/ }).click();
  assert.equal(await page.locator('.agent-revision').count(), 2);
  await page.getByRole('button', { name: 'Undo edit' }).click();
  await page.waitForSelector('.agent-notice');
  const undone = await page.evaluate(async () => {
    const { useSimulatorStore } = await import('/src/store/useSimulatorStore.ts');
    const { useEditorStore } = await import('/src/store/useEditorStore.ts');
    return {
      color: useSimulatorStore.getState().components.find((c) => c.id === 'led1').properties.color,
      content: useEditorStore.getState().files[0].content,
      running: useSimulatorStore.getState().running,
    };
  });
  assert.equal(undone.color, 'red');
  assert.match(undone.content, /manual comment/);
  assert.equal(undone.running, false);
  await page.getByRole('button', { name: 'Undo edit' }).click();
  assert.equal(
    await page.evaluate(
      async () =>
        (await import('/src/store/useSimulatorStore.ts')).useSimulatorStore
          .getState()
          .components.find((c) => c.id === 'led1').properties.color,
    ),
    'green',
  );
  await page.evaluate(async () => {
    const { useSimulatorStore } = await import('/src/store/useSimulatorStore.ts');
    useSimulatorStore.getState().updateComponent('led1', { x: 650 });
  });
  await page.getByRole('button', { name: 'Undo edit' }).click();
  assert.match(await page.locator('.agent-notice').innerText(), /Undo is blocked/);
  if (process.env.AGENT_SCREENSHOT_DIR) {
    await fs.mkdir(process.env.AGENT_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: `${process.env.AGENT_SCREENSHOT_DIR}/agent-checkpoints.png` });
    await page.getByRole('tab', { name: /CHAT/ }).click();
    await page.screenshot({ path: `${process.env.AGENT_SCREENSHOT_DIR}/agent-chat.png` });
  }
  await page.getByLabel('Collapse agent').click();
  await page.getByLabel('Open circuit agent').click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.locator('.agent-panel').evaluate((e) => e.getBoundingClientRect().width),
    390,
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (process.env.AGENT_SCREENSHOT_DIR)
    await page.screenshot({ path: `${process.env.AGENT_SCREENSHOT_DIR}/agent-mobile.png` });
  assert.deepEqual(errors, []);
  console.log(
    'PASS: fixture generation → real electrical validation → AVR simulation/LED transitions → contextual edit → undo/redo → conflict protection → mobile layout',
  );
} catch (error) {
  console.error(await page.locator('.agent-panel').innerText());
  console.error('Browser errors:', errors);
  throw error;
} finally {
  await browser.close();
}
