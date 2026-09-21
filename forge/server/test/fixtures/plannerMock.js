// Forge — deterministic offline planner (mock provider).
//
// A small knowledge base of demo builds (electronics-first, because the
// sim track runs on the Velxio emulator) plus a generic fallback template.
// Output is a RAW plan object; the pipeline coerces it through
// sanitizePlan(), which is the trust boundary shared with the LLM planner.

const KB = [
  // ── MP3 player ────────────────────────────────────────────────────────────
  {
    match: /mp3|music player|audio player|radio player/i,
    bom: [
      { name: 'RP2040 or ATmega328P microcontroller', qty: 1, cost_usd: 3 },
      { name: 'Audio DAC module (e.g. PCM5102 board)', qty: 1, cost_usd: 8 },
      { name: '3.7V Li-ion 18650 battery + holder', qty: 1, cost_usd: 9 },
      { name: 'TP4056 charge module', qty: 1, cost_usd: 2 },
      { name: '1M resistor', qty: 1, cost_usd: 0.2 },
      { name: '10k resistor', qty: 2, cost_usd: 0.5 },
      { name: '100nF capacitor', qty: 4, cost_usd: 0.5 },
      { name: '8 ohm 2W speaker', qty: 1, cost_usd: 4 },
      { name: 'Tactile buttons', qty: 2, cost_usd: 1 },
      { name: 'Solderable PCB or breadboard + wire', qty: 1, cost_usd: 5 },
      { name: 'Plastic enclosure', qty: 1, cost_usd: 6 },
    ],
    phases: [
      {
        name: 'Design & simulate',
        steps: [
          {
            title: 'Set up the workbench and read the parts list',
            track: 'physical',
            instructions: 'Lay out every part from the bill of materials, identify each one, and get your soldering iron, solder, and wire cutters ready (iron can stay unheated until step 3).',
            materials: ['Plastic enclosure', 'Tactile buttons'],
            tools: ['workbench', 'wire cutters'],
            safety: [],
            definition_of_done: ['All bill-of-materials parts physically present and identified'],
            skills: ['planning'],
          },
          {
            title: 'Simulate the control circuit in Velxio',
            track: 'sim',
            instructions: 'Open the generated Velxio project for the button + control stage and confirm the simulated tones respond to the simulated button before any physical work.',
            materials: ['computer'],
            tools: ['Velxio'],
            safety: [],
            definition_of_done: ['Simulated control circuit responds to the simulated button'],
            skills: ['simulation'],
          },
        ],
      },
      {
        name: 'Power stage',
        steps: [
          {
            title: 'Solder the battery charge circuit',
            track: 'physical',
            instructions: 'Solder the TP4056 module: battery terminals, the 1M charge resistor to PROG, and the USB input. Keep the iron on its stand between joints and work on a non-flammable surface.',
            materials: ['TP4056 charge module', '3.7V Li-ion 18650 battery + holder', '1M resistor'],
            tools: ['soldering iron', 'solder', 'multimeter'],
            safety: [
              { hazard: 'heat', severity: 'high', note: 'hot soldering iron — burn risk' },
              { hazard: 'fumes', severity: 'warn', note: 'solder flux fumes — ventilate' },
            ],
            definition_of_done: ['Module soldered, no bridged pads, battery charges when USB is connected'],
            skills: ['soldering'],
          },
          {
            title: 'Verify the power rails',
            track: 'physical',
            instructions: 'Power the board from the battery and measure the 3.3V and 5V rails with the multimeter.',
            materials: ['3.7V Li-ion 18650 battery + holder'],
            tools: ['multimeter'],
            safety: [{ hazard: 'electrical', severity: 'warn', note: 'live battery power' }],
            definition_of_done: ['Rails within 5% of nominal with a loaded measurement'],
            skills: ['testing'],
          },
        ],
      },
      {
        name: 'Playback stage',
        steps: [
          {
            title: 'Solder the DAC and microcontroller',
            track: 'physical',
            instructions: 'Mount the DAC module and solder the microcontroller plus passives (100nF caps, 10k pull-ups) following the schematic in the Velxio project.',
            materials: ['Audio DAC module (e.g. PCM5102 board)', 'RP2040 or ATmega328P microcontroller', '100nF capacitor', '10k resistor'],
            tools: ['soldering iron', 'solder'],
            safety: [{ hazard: 'heat', severity: 'high', note: 'hot soldering iron — burn risk' }],
            definition_of_done: ['All ICs seated, passives soldered, no bridges'],
            skills: ['soldering'],
          },
          {
            title: 'Wire the speaker and buttons',
            track: 'physical',
            instructions: 'Wire the 8 ohm speaker to the DAC output lines and the two tactile buttons to the input pins, matching the Velxio schematic. Keep speaker leads short.',
            materials: ['8 ohm 2W speaker', 'Tactile buttons'],
            tools: ['wire strippers'],
            safety: [{ hazard: 'electrical', severity: 'warn', note: 'speaker draws real current — short wiring' }],
            definition_of_done: ['Speaker and buttons wired per the schematic'],
            skills: ['wiring'],
          },
        ],
      },
      {
        name: 'Test & finish',
        steps: [
          {
            title: 'First power-on test',
            track: 'physical',
            instructions: 'Power on with the speaker disconnected first, then connect it and play a test tone. Watch the DAC for heat on first power-up.',
            materials: ['8 ohm 2W speaker'],
            tools: ['multimeter'],
            safety: [{ hazard: 'electrical', severity: 'warn', note: 'first power-on — expect to check for shorts' }],
            definition_of_done: ['Test tone audible at reasonable volume, no heat after 1 minute'],
            skills: ['testing'],
          },
          {
            title: 'Mount into the enclosure',
            track: 'physical',
            instructions: 'Mount the speaker, USB port, and buttons into the enclosure; fit the PCB inside and close it up so nothing shorts against the case.',
            materials: ['Plastic enclosure'],
            tools: ['drill or hand tools'],
            safety: [],
            definition_of_done: ['Everything fits, no exposed live parts, case closes'],
            skills: ['assembly'],
          },
        ],
      },
    ],
    acceptance: [
      'Player powers on from the battery and plays audio from the speaker',
      'Playback can be controlled by the buttons',
      'Unit is mounted in an enclosure with no exposed live parts',
    ],
  },

  // ── Iron Man helmet ───────────────────────────────────────────────────────
  {
    match: /iron ?man|stark|arc ?reactor/i,
    bom: [
      { name: 'EVA foam 10mm (shell panels)', qty: 4, cost_usd: 20 },
      { name: 'PVC pipe for headband frame', qty: 1, cost_usd: 8 },
      { name: 'LED matrix 64x32 (or equivalent)', qty: 1, cost_usd: 25 },
      { name: 'ESP32 board', qty: 1, cost_usd: 8 },
      { name: 'LED driver / shift registers', qty: 2, cost_usd: 6 },
      { name: '5000mAh 3.7V LiPo + holder', qty: 1, cost_usd: 18 },
      { name: 'USB-C charging module', qty: 1, cost_usd: 4 },
      { name: 'Wire + heat-shrink', qty: 1, cost_usd: 6 },
      { name: 'Contact adhesive + epoxy', qty: 1, cost_usd: 10 },
    ],
    phases: [
      {
        name: 'Design & simulate',
        steps: [
          {
            title: 'Pick a helmet version and build the pattern',
            track: 'physical',
            instructions: 'Choose a helmet version, measure your head, and mark the shell panel pattern onto the foam. Plan the visor cut-out for the LED matrix.',
            materials: ['EVA foam 10mm (shell panels)'],
            tools: ['measuring tape', 'pencil', 'rotary cutter'],
            safety: [],
            definition_of_done: ['Pattern complete, head measurements taken, visor cut-out planned'],
            skills: ['planning'],
          },
          {
            title: 'Simulate the LED matrix driver in Velxio',
            track: 'sim',
            instructions: 'Open the generated Velxio project for the ESP32 + matrix driver and confirm the simulated matrix scrolls a test pattern before wiring the real thing.',
            materials: ['computer'],
            tools: ['Velxio'],
            safety: [],
            definition_of_done: ['Simulated matrix scrolls a test pattern'],
            skills: ['simulation'],
          },
        ],
      },
      {
        name: 'Shell',
        steps: [
          {
            title: 'Cut the shell panels',
            track: 'physical',
            instructions: 'Cut all shell panels from the foam with the rotary cutter on a cutting mat. Cut the visor opening last, when the panels are already joined.',
            materials: ['EVA foam 10mm (shell panels)'],
            tools: ['rotary cutter', 'cutting mat'],
            safety: [{ hazard: 'cutting', severity: 'high', note: 'rotary cutter/knife — finger safety' }],
            definition_of_done: ['All panels cut to pattern, visor opening clean'],
            skills: ['cutting'],
          },
          {
            title: 'Shape and dry-fit the panels',
            track: 'physical',
            instructions: 'Lightly curve the panels to your head shape, dry-fit them together, and check the total weight over your head. Target under 1.5kg.',
            materials: ['EVA foam 10mm (shell panels)'],
            tools: ['headband frame (PVC pipe)'],
            safety: [{ hazard: 'adhesives', severity: 'warn', note: 'ventilation for contact adhesive' }],
            definition_of_done: ['Panels dry-fit over the head, total weight under 1.5kg'],
            skills: ['fitting'],
          },
        ],
      },
      {
        name: 'Electronics',
        steps: [
          {
            title: 'Solder the matrix driver board',
            track: 'physical',
            instructions: 'Solder the ESP32, driver/shift registers, and wiring headers per the simulated schematic. Keep the iron on the stand between joints.',
            materials: ['ESP32 board', 'LED driver / shift registers'],
            tools: ['soldering iron', 'solder', 'multimeter'],
            safety: [{ hazard: 'heat', severity: 'high', note: 'hot soldering iron — burn risk' }],
            definition_of_done: ['Driver board soldered, no bridges, headers firm'],
            skills: ['soldering'],
          },
          {
            title: 'Program the matrix firmware',
            track: 'physical',
            instructions: 'Flash the matrix firmware (test pattern + controller mode) to the ESP32 and verify the pattern on the bench before mounting.',
            materials: ['ESP32 board'],
            tools: ['computer', 'USB cable'],
            safety: [],
            definition_of_done: ['Firmware scrolls the test pattern on the bench'],
            skills: ['coding'],
          },
          {
            title: 'Wire the battery and USB-C module',
            track: 'physical',
            instructions: 'Wire the LiPo holder to the driver board and the USB-C charging module, with heat-shrink on every joint.',
            materials: ['5000mAh 3.7V LiPo + holder', 'USB-C charging module', 'Wire + heat-shrink'],
            tools: ['soldering iron', 'multimeter'],
            safety: [{ hazard: 'electrical', severity: 'warn', note: 'LiPo handling — no shorting the terminals' }],
            definition_of_done: ['Battery and charging wired, charges over USB-C'],
            skills: ['wiring'],
          },
        ],
      },
      {
        name: 'Integration',
        steps: [
          {
            title: 'Mount the matrix into the visor',
            track: 'physical',
            instructions: 'Fix the LED matrix into the visor opening so it is flush and covered when closed, and route the data cables to the driver board.',
            materials: ['LED matrix 64x32 (or equivalent)', 'Wire + heat-shrink'],
            tools: ['adhesive', 'cutting tools'],
            safety: [{ hazard: 'cutting', severity: 'warn', note: 'trimming cables — cut away from hands' }],
            definition_of_done: ['Matrix flush in the visor, cables routed'],
            skills: ['assembly'],
          },
          {
            title: 'Route the harness and fasten the headband',
            track: 'physical',
            instructions: 'Route the wire harness through the headband frame, mount the battery pack low on the back, and fasten everything with the frame straps.',
            materials: ['PVC pipe for headband frame', 'Wire + heat-shrink'],
            tools: ['zip ties', 'adhesive'],
            safety: [],
            definition_of_done: ['Harness secured, battery mounted low, no snag points'],
            skills: ['assembly'],
          },
        ],
      },
      {
        name: 'Test',
        steps: [
          {
            title: 'Full integration test',
            track: 'physical',
            instructions: 'Wear the helmet with the battery connected: run the matrix controller mode, check comfort for 10 minutes, and time the battery runtime.',
            materials: ['5000mAh 3.7V LiPo + holder'],
            tools: ['multimeter', 'timer'],
            safety: [{ hazard: 'electrical', severity: 'warn', note: 'LiPo handling — inspect for swelling before wear' }],
            definition_of_done: ['Matrix responds to the controller', 'Battery runs at least 1 hour', 'Comfortable for 10 minutes of wear'],
            skills: ['testing'],
          },
        ],
      },
    ],
    acceptance: [
      'The matrix lights up and responds to the controller',
      'The helmet fits over the head and is wearable for at least 10 minutes',
      'Battery provides at least 1 hour of runtime',
      'No exposed live wiring anywhere on the helmet',
    ],
  },

  // ── LED desk lamp ─────────────────────────────────────────────────────────
  {
    match: /desk ?lamp|led ?lamp|\blamp\b/i,
    bom: [
      { name: '5V LED strip (1m)', qty: 1, cost_usd: 6 },
      { name: '5V LED driver (constant current)', qty: 1, cost_usd: 4 },
      { name: 'SPST toggle switch', qty: 1, cost_usd: 2 },
      { name: 'DC barrel jack + power cord', qty: 1, cost_usd: 4 },
      { name: 'Wooden or acrylic base', qty: 1, cost_usd: 8 },
      { name: 'Wire', qty: 1, cost_usd: 3 },
    ],
    phases: [
      {
        name: 'Simulate',
        steps: [
          {
            title: 'Simulate the switch + LED circuit in Velxio',
            track: 'sim',
            instructions: 'Open the generated Velxio project (switch + LED) and confirm the simulated switch toggles the simulated LED.',
            materials: ['computer'],
            tools: ['Velxio'],
            safety: [],
            definition_of_done: ['Simulated switch toggles the simulated LED'],
            skills: ['simulation'],
          },
        ],
      },
      {
        name: 'Build',
        steps: [
          {
            title: 'Prepare the housing and cable channel',
            track: 'physical',
            instructions: 'Cut and sand the base, and route the cable channel so the cord exits with strain relief.',
            materials: ['Wooden or acrylic base', 'DC barrel jack + power cord'],
            tools: ['saw', 'sandpaper'],
            safety: [{ hazard: 'cutting', severity: 'warn', note: 'saw use — clamp the workpiece' }],
            definition_of_done: ['Base cut, sanded, cable channel clear'],
            skills: ['cutting'],
          },
          {
            title: 'Solder the driver, switch, and jack',
            track: 'physical',
            instructions: 'Solder the constant-current driver between the jack and the LED strip, and put the toggle switch in series on the supply side.',
            materials: ['5V LED driver (constant current)', 'SPST toggle switch', 'DC barrel jack + power cord'],
            tools: ['soldering iron', 'solder'],
            safety: [{ hazard: 'heat', severity: 'high', note: 'hot soldering iron — burn risk' }],
            definition_of_done: ['Driver, switch, and jack soldered with no bridges'],
            skills: ['soldering'],
          },
          {
            title: 'Mount the LED strip and wire it up',
            track: 'physical',
            instructions: 'Cut the LED strip to size at a marked cut point, mount it on the base, and connect it to the driver output.',
            materials: ['5V LED strip (1m)', 'Wire'],
            tools: ['wire strippers'],
            safety: [],
            definition_of_done: ['Strip mounted at the cut point, connected to the driver'],
            skills: ['wiring'],
          },
        ],
      },
      {
        name: 'Test',
        steps: [
          {
            title: 'Assemble and test',
            track: 'physical',
            instructions: 'Close the housing, plug in, and run the lamp for 10 minutes while checking temperatures on the driver.',
            materials: [],
            tools: ['multimeter'],
            safety: [{ hazard: 'electrical', severity: 'warn', note: 'mains-adjacent: unplug while checking' }],
            definition_of_done: ['Switch turns the light on and off', 'No part gets hot after 10 minutes', 'Cable strain-relieved and tidy'],
            skills: ['testing'],
          },
        ],
      },
    ],
    acceptance: [
      'The switch turns the light on and off',
      'No part gets hot after 10 minutes of use',
      'Cable is tidy and strain-relieved',
    ],
  },
];

function genericPlan(goal) {
  const g = String(goal).trim();
  return {
    bom: [
      { name: `Main materials for: ${g}`, qty: 1, cost_usd: 20 },
      { name: 'Fasteners, adhesive and joining hardware', qty: 1, cost_usd: 5 },
      { name: 'Power source (if the build needs one)', qty: 1, cost_usd: 8 },
    ],
    phases: [
      {
        name: 'Clarify the design',
        steps: [
          {
            title: 'Write the one-page spec',
            track: 'physical',
            instructions: `Fix what "done" means for: ${g}. Write a one-page spec with a concrete definition of done and draft the parts list.`,
            materials: [],
            tools: ['notes'],
            safety: [],
            definition_of_done: ['One-page spec written with a definition of done', 'Parts list drafted'],
            skills: ['planning'],
          },
        ],
      },
      {
        name: 'Gather & prepare',
        steps: [
          {
            title: 'Source parts and prep the workspace',
            track: 'physical',
            instructions: 'Order or collect every part on the list, and set up a clean, well-lit, ventilated workspace with the right tools within reach.',
            materials: ['Main materials for: ' + g, 'Fasteners, adhesive and joining hardware'],
            tools: ['workbench'],
            safety: [{ hazard: 'general', severity: 'warn', note: 'ventilate when using adhesives or solvents' }],
            definition_of_done: ['Parts on hand', 'Workspace set up and safe'],
            skills: ['planning'],
          },
        ],
      },
      {
        name: 'Build',
        steps: [
          {
            title: 'Assemble the main structure',
            track: 'physical',
            instructions: 'Build the main structure per the spec, checking alignment and fit as you go rather than at the end.',
            materials: ['Main materials for: ' + g],
            tools: ['per spec'],
            safety: [{ hazard: 'general', severity: 'warn', note: 'follow each tool’s safety notes' }],
            definition_of_done: ['Main structure assembled per spec'],
            skills: ['assembly'],
          },
          {
            title: 'Add subsystems and connections',
            track: 'physical',
            instructions: 'Attach the remaining subsystems (power, controls, or whatever the spec defines) and make all connections.',
            materials: ['Power source (if the build needs one)'],
            tools: ['per spec'],
            safety: [{ hazard: 'general', severity: 'warn', note: 'follow each subsystem’s safety notes' }],
            definition_of_done: ['All subsystems attached and connected'],
            skills: ['assembly', 'wiring'],
          },
        ],
      },
      {
        name: 'Test & finish',
        steps: [
          {
            title: 'Run the acceptance test',
            track: 'physical',
            instructions: 'Test the finished build against the one-page spec, note any gaps, and fix them.',
            materials: [],
            tools: ['per spec'],
            safety: [],
            definition_of_done: ['Project meets the spec written in step 1'],
            skills: ['testing'],
          },
          {
            title: 'Document and finish',
            track: 'physical',
            instructions: 'Photo/log the finished build and write down what you would change next time.',
            materials: [],
            tools: ['camera'],
            safety: [],
            definition_of_done: ['Photo or log of the finished build'],
            skills: ['documentation'],
          },
        ],
      },
    ],
    acceptance: [
      `${g} is assembled and structurally complete`,
      `It works as described in the original request: ${g}`,
      'All safety-critical steps were completed with proper care',
    ],
  };
}

export function createPlannerMock() {
  return async function planMock(goal) {
    const g = String(goal || '');
    for (const kb of KB) {
      if (kb.match.test(g)) return { ...kb };
    }
    return genericPlan(g);
  };
}
