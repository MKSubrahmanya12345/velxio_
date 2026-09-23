/**
 * Config → dossier. Pure. Every number the sim will use is either cited,
 * taken from a published band, estimated, or marked as something the human
 * still has to measure. Editing a field and calling derive() again is the
 * whole "research" loop — there is no second, hidden model.
 */

import { G, SOURCES } from './knowledge';
import { parseIntent } from './intent';
import { mustScene, placeRotors, quadInertia } from './flight';
import type {
  ArmPlan,
  ClassCard,
  Confidence,
  Dossier,
  FieldSpec,
  MachineConfig,
  Metric,
  Note,
  SimPlan,
  Warning,
  Wire,
} from './types';

const FIELD_KEYS = [
  'massKg', 'rotors', 'wheelbaseM', 'propDiameterM', 'thrustPerMotorN', 'reactionM',
  'cells', 'mah', 'cRating', 'figureOfMerit', 'motorEfficiency', 'airDensity',
  'windMs', 'windFromDeg', 'hoverAltitudeM', 'maxTiltDeg', 'jurisdiction', 'fc',
  'attitudeWn', 'altitudeWn', 'trackM', 'wheelForceN', 'rollingCoeff', 'medium',
  'wingAreaM2', 'cl', 'cd', 'cruiseThrustN', 'burnS', 'thrustAxis',
  'linkLengthM', 'payloadKg', 'gearRatio', 'motorTorqueNm',
  'solarW', 'loadW', 'batteryWh', 'nightHours', 'peakAmpsEach', 'escAmps',
] as const;

export type FieldId = typeof FIELD_KEYS[number];

export function setField(config: MachineConfig, id: string, raw: string): MachineConfig {
  if (!(FIELD_KEYS as readonly string[]).includes(id)) return config;
  const next: MachineConfig = {
    ...config,
    confirmed: config.confirmed.includes(id) ? config.confirmed : [...config.confirmed, id],
  };
  if (id === 'jurisdiction' || id === 'fc' || id === 'thrustAxis' || id === 'medium') {
    (next as unknown as Record<string, unknown>)[id] = raw;
    return next;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return config;
  (next as unknown as Record<string, number>)[id] = n;
  if (id === 'rotors') next.rotors = n >= 7 ? 8 : n >= 5 ? 6 : 4;
  if (id === 'massKg') next.massKg = clamp(n, 0.02, 200);
  if (id === 'thrustPerMotorN') next.thrustPerMotorN = clamp(n, 0, 5000);
  return next;
}

export function derive(config: MachineConfig): Dossier {
  const intent = parseIntent(config.prompt || config.name);
  const notes: Note[] = [];
  const warnings: Warning[] = [];
  const plan = compilePlan(config);
  const fields = fieldsFor(config);

  notes.push({
    id: 'heard',
    kind: 'research',
    title: 'What you asked',
    body: config.prompt.trim()
      ? `“${config.prompt.trim()}”`
      : 'No sentence yet — the numbers below are the blank machine.',
  });

  if (config.archetype === 'multirotor') pushMultirotorNotes(config, intent.assumed, notes, warnings);
  else if (config.archetype === 'surface') pushSurfaceNotes(config, notes, warnings);
  else if (config.archetype === 'wing') pushWingNotes(config, notes, warnings);
  else if (config.archetype === 'ballistic') pushBallisticNotes(config, notes, warnings);
  else if (config.archetype === 'arm') pushArmNotes(config, plan.kind === 'arm' ? plan : null, notes, warnings);
  else pushStationNotes(config, notes, warnings);

  notes.push({
    id: 'limit-solver',
    kind: 'limit',
    title: 'What this page will and will not simulate',
    body: limitText(config),
  });

  const cited = new Set(notes.flatMap((n) => n.sourceIds ?? []));
  for (const f of fields) for (const id of f.sourceIds ?? []) cited.add(id);

  return {
    title: config.name,
    summary: summary(config, plan),
    archetype: config.archetype,
    fields,
    notes,
    sources: SOURCES.filter((s) => cited.has(s.id)),
    warnings,
    metrics: metrics(config, plan),
    wires: wires(config),
    classCard: classCard(config),
    plan,
  };
}

function pushMultirotorNotes(config: MachineConfig, assumedBare: boolean, notes: Note[], warnings: Warning[]): void {
  const weight = config.massKg * G;
  const tw = config.rotors * config.thrustPerMotorN / Math.max(weight, 1e-6);
  const hover = tw > 0 ? 1 / tw : Infinity;
  const disk = diskLoading(config);
  const power = hoverPower(config);
  const packV = config.cells * 3.7;
  const wh = packV * config.mah / 1000;
  const usable = wh * 0.8;
  const minutes = power.electrical > 0 ? (usable / power.electrical) * 60 : 0;

  if (assumedBare && config.preset === 'first-light' && !config.confirmed.includes('massKg')) {
    notes.push({
      id: 'assume-size',
      kind: 'assumption',
      title: 'You did not name a size',
      body: 'A bare “drone” is not a 5-inch freestyle. That class is about 600–750 g, fast, and a poor first aircraft. I assumed a 3-inch toothpick in the published 100–150 g band, four rotors, 4S. Switch the preset if you meant the 5-inch, the 7-inch, or the Arduino 450. A field you have not confirmed is still an assumption.',
      sourceIds: ['uav-kv', 'tdf'],
      fieldId: 'massKg',
    });
  }
  if (config.preset === 'five-freestyle') {
    notes.push({
      id: 'class-5',
      kind: 'research',
      title: '5-inch freestyle class',
      body: 'The guides describe a 6S 1300 mAh pack, a 2207-class motor around 1700–1960 KV, a 45–55 A 4-in-1, a 5.0–5.1 inch tri-blade, and an all-up weight around 620 g with a camera (band 600–750 g). Hover throttle for that class is published as 22–28%. I set static thrust so a linearized motor command sits at 25% at 620 g. If your motor’s datasheet thrust is different, type it in — hover throttle in the sim will move, which is the point.',
      sourceIds: ['uav-5v7', 'xteam-5', 'uav-kv'],
    });
  }
  if (config.preset === 'seven-lr') {
    notes.push({
      id: 'class-7',
      kind: 'research',
      title: '7-inch long-range class',
      body: 'Published band: 800–1100 g, 6S, 1300–1600 KV on a 2507–2807, hover throttle 15–20%, cruise 5–10 A, 18–30 min when actually cruising. Capacity is a choice — the same guides mention an 1800 mAh LiPo and a much larger Li-ion pack. I used 3000 mAh as a mid long-range pack, not as a measurement. Thrust is back-calculated to a 17.5% hover command at 950 g.',
      sourceIds: ['uav-5v7', 'uav-kv'],
    });
  }
  if (config.preset === 'arduino-450') {
    notes.push({
      id: 'class-450',
      kind: 'research',
      title: 'The Arduino 450 is a learning stack, not a 2026 daily flier',
      body: 'CodeDroneDIY publishes a Nano, an MPU6050, Afro 20 A ESCs, Multistar 2216-800KV, 10×4.5 props and a 4S 3000 mAh pack on a 450 mm frame. It does not publish all-up weight or a thrust table. 1.05 kg and 8.5 N per motor are placeholders. Weigh the finished craft. Replace thrust with a hanging-scale pull or the motor sheet.',
      sourceIds: ['codedrone'],
      fieldId: 'thrustPerMotorN',
    });
  }
  if (config.preset === 'whoop') {
    notes.push({
      id: 'class-whoop',
      kind: 'research',
      title: '2-inch whoop class',
      body: 'Published band: 40–60 g, 2S, 8000–10000 KV, 1102–1103 stator. Wheelbase, capacity and thrust are not in that table. 85 mm, 300 mAh and 0.55 N are estimates. Indoor wind is set to zero because you cannot outrun a draft in a room on this disc.',
      sourceIds: ['uav-kv'],
    });
  }
  if (config.preset === 'first-light') {
    notes.push({
      id: 'class-3',
      kind: 'research',
      title: '3-inch toothpick class',
      body: 'Published band: 100–150 g, 3S–4S, 3000–4500 KV, 1303–1404, 3-inch props. Frame diagonals in the compatibility guide run 120–150 mm. Pack capacity for a 3-inch is given as 450–850 mAh, so 650 is the middle of that band, not your pack. Static thrust is not published there. 2.45 N (about 250 g-force) per motor is a placeholder you replace with a datasheet or a thrust stand.',
      sourceIds: ['uav-kv', 'tdf'],
      fieldId: 'thrustPerMotorN',
    });
  }

  notes.push({
    id: 'calc-tw',
    kind: 'calc',
    title: 'Thrust-to-weight and hover command',
    body: `Weight = ${fmt(config.massKg, 3)} kg × ${G} = ${fmt(weight, 2)} N. Total thrust = ${config.rotors} × ${fmt(config.thrustPerMotorN, 2)} N = ${fmt(config.rotors * config.thrustPerMotorN, 2)} N. T/W = ${fmt(tw, 2)}. Linearized hover command = weight / total thrust = ${fmt(hover * 100, 0)}%. A real prop is closer to thrust ∝ rpm², so the stick percentage on a flight controller will not match this unless the firmware linearizes it. The sim’s actuator is a force command, so this percentage is the one the mixer uses.`,
    fieldId: 'thrustPerMotorN',
  });
  notes.push({
    id: 'calc-disk',
    kind: 'calc',
    title: 'Disc loading',
    body: `Prop area each = π × (${fmt(config.propDiameterM / 2, 3)})² = ${fmt(Math.PI * (config.propDiameterM / 2) ** 2, 4)} m². Disc loading = weight / (rotors × area) = ${fmt(disk, 1)} N/m² (${fmt(disk / G, 2)} kg/m²). Lower loading hovers on less induced power. It does not, by itself, mean a lower hover throttle — that is excess thrust.`,
    sourceIds: ['momentum'],
  });
  notes.push({
    id: 'calc-power',
    kind: 'calc',
    title: 'Hover power, momentum theory',
    body: `Thrust per rotor T = ${fmt(power.tEach, 2)} N. Induced velocity = √(T / (2 × ${fmt(config.airDensity, 3)} × A)) = ${fmt(power.vi, 2)} m/s. Ideal power = ${config.rotors} × T × vi = ${fmt(power.ideal, 1)} W. Electrical ≈ ideal / (FM ${fmt(config.figureOfMerit, 2)} × motor efficiency ${fmt(config.motorEfficiency, 2)}) = ${fmt(power.electrical, 1)} W. Pack = ${config.cells} × 3.7 V × ${fmt(config.mah / 1000, 2)} Ah = ${fmt(wh, 1)} Wh. Usable to 20% reserve = ${fmt(usable, 1)} Wh. Hover endurance ≈ ${fmt(minutes, 1)} min. This is hover in still air, not the cruise minutes in the class guides. Those include forward flight. Change mass, prop or FM and this number moves. A wattmeter on the bench is the measurement.`,
    sourceIds: ['momentum', 'bohorquez'],
    fieldId: 'figureOfMerit',
  });

  if (config.peakAmpsEach > 0) {
    const packA = config.peakAmpsEach * config.rotors;
    const burst = (config.mah / 1000) * config.cRating;
    notes.push({
      id: 'calc-amps',
      kind: 'calc',
      title: 'Current headroom',
      body: `Class peak is about ${fmt(config.peakAmpsEach, 0)} A per motor, so ${fmt(packA, 0)} A if all of them are there at once. The pack’s C-rating allows ${fmt(config.mah / 1000, 2)} Ah × ${fmt(config.cRating, 0)} C = ${fmt(burst, 0)} A. ESC rating on the sheet is ${config.escAmps > 0 ? `${fmt(config.escAmps, 0)} A` : 'not set'}. The compatibility guide wants about 20% ESC headroom over the motor’s peak. C-ratings on hobby packs are often a burst number, not a continuous one.`,
      sourceIds: ['tdf', 'xteam-5'],
      fieldId: 'escAmps',
    });
    if (config.escAmps > 0 && config.escAmps < config.peakAmpsEach * 1.2) {
      warnings.push({
        level: 'warn',
        text: `ESC ${fmt(config.escAmps, 0)} A is under 20% headroom on a ${fmt(config.peakAmpsEach, 0)} A motor peak. Size the ESC to the motor, not to the hover current.`,
      });
    }
    if (burst > 0 && packA > burst * 1.05) {
      warnings.push({
        level: 'warn',
        text: `All motors at the class peak (${fmt(packA, 0)} A) exceed the pack’s C-rating (${fmt(burst, 0)} A). Burst may survive. Sustained will not. Confirm with a wattmeter.`,
      });
    }
  }

  if (tw < 1) {
    warnings.push({ level: 'block', text: 'Total thrust is below weight. It will not leave the ground. Raise thrust or cut mass — the sim will show the failure either way.' });
  } else if (tw < 1.5) {
    warnings.push({ level: 'warn', text: `T/W is ${fmt(tw, 2)}. That can hover in still air and has almost nothing left for tilt, wind, or a voltage sag.` });
  }
  if (hover > 0.72 && tw >= 1) {
    warnings.push({ level: 'warn', text: `Hover command is ${fmt(hover * 100, 0)}%. A gust or a punch-out has nowhere to go.` });
  }
  const adjacent = config.wheelbaseM / Math.SQRT2;
  if (config.propDiameterM > adjacent * 0.92 && config.rotors === 4) {
    warnings.push({
      level: 'warn',
      text: `A ${fmt(config.propDiameterM * 39.37, 1)}″ prop on a ${fmt(config.wheelbaseM * 1000, 0)} mm diagonal meets the next prop. Adjacent motor spacing is about ${fmt(adjacent * 1000, 0)} mm.`,
    });
  }
  if (config.figureOfMerit < 0.35 || config.figureOfMerit > 0.75) {
    warnings.push({ level: 'info', text: 'Figure of merit outside 0.35–0.75 is outside both the small-rotor measurement (0.42) and a healthy full-size rotor (~0.7). The endurance number will lie.' });
  }

  pushLaw(config, warnings, notes);

  notes.push({
    id: 'bench-weigh',
    kind: 'bench',
    title: 'On your bench, not in this tab',
    body: benchBody(config),
    fieldId: 'massKg',
  });
  notes.push({
    id: 'q-jurisdiction',
    kind: 'question',
    title: config.jurisdiction === 'unset' ? 'Where will you actually fly?' : 'Jurisdiction is set — still read the primary source',
    body: config.jurisdiction === 'unset'
      ? 'I will not guess your airspace from the fact that this tab is open. Pick a jurisdiction and the weight class gets a paperwork note. It is a summary of a public page, not a clearance.'
      : 'The note below is a summary. The link in Sources is the page to read before a prop turns in anger.',
    fieldId: 'jurisdiction',
  });
}

function pushLaw(config: MachineConfig, warnings: Warning[], notes: Note[]): void {
  const g = config.massKg * 1000;
  if (config.jurisdiction === 'IN') {
    const cat = g <= 250 ? 'nano (≤ 250 g)' : g <= 2000 ? 'micro (250 g – 2 kg)' : g <= 25000 ? 'small (2 – 25 kg)' : 'medium or large';
    notes.push({
      id: 'law-in',
      kind: 'research',
      title: `India, on the published weight table: ${cat}`,
      body: 'Public summaries of the Drone Rules, 2021 put nano at or under 250 g, micro up to 2 kg, small up to 25 kg. Those summaries say nano recreational flight in a green zone has the lightest paperwork, and that everything heavier wants a Unique Identification Number on Digital Sky. Remote pilot certificates kick in as the use gets commercial or the aircraft gets heavier. This is not a reading of the statute. Confirm on digitalsky.dgca.gov.in before you fly. Belagavi or anywhere else, the zone map is the authority, not this paragraph.',
      sourceIds: ['dgca'],
    });
    if (g > 250) {
      warnings.push({ level: 'warn', text: `At ${fmt(g, 0)} g this is not a nano in the Indian table. Registration is the human’s job. The sim does not file it.` });
    }
  } else if (config.jurisdiction === 'US') {
    notes.push({
      id: 'law-us',
      kind: 'research',
      title: 'United States, recreational',
      body: 'The FAA recreational page says register at 250 g (0.55 lb) and above, take TRUST and carry the proof, and fly at or below 400 ft in Class G. A registered aircraft also has Remote ID obligations, with a FRIA exception the FAA page describes. Sub-250 g does not escape TRUST. Confirm on faa.gov — the rule text moves, this paragraph does not track it for you.',
      sourceIds: ['faa'],
    });
    if (g >= 250) warnings.push({ level: 'info', text: 'At or above 250 g the FAA page requires registration for recreational outdoor flight, plus TRUST either way.' });
  } else if (config.jurisdiction === 'EU') {
    notes.push({
      id: 'law-eu',
      kind: 'question',
      title: 'Europe — go to the primary page',
      body: 'EASA’s open category is the right place to start, and the subclass depends on weight and on the aircraft’s class mark. I am not going to paraphrase a regulation I have not opened in this pass. Read https://www.easa.europa.eu/en/domains/civil-drones and your national aviation authority.',
    });
  }
}

function pushSurfaceNotes(config: MachineConfig, notes: Note[], warnings: Warning[]): void {
  notes.push({
    id: 'surface-model',
    kind: 'research',
    title: config.medium === 'water' ? 'A hull, approximated' : 'Differential drive',
    body: config.medium === 'water'
      ? 'Two signed thrusters on a track, high drag, and a floor standing in for the waterline. It will not heel, ship a wave, or cavitate. It will show whether the thrust you configured can make way, and whether cutting throttle stops it.'
      : 'Two signed wheel forces at ±track/2. Unequal force yaws the body because the force is applied off the centre of mass — the same r × F the quad uses. Rolling resistance is a controller brake plus a small drag term, not a tyre model. Ground contact damping is off, or the floor would eat the speed the way the drop-test damper does.',
  });
  if (config.wheelForceN < config.massKg * 0.3) {
    warnings.push({ level: 'warn', text: 'Wheel force is small next to the weight. It will creep, or not start, depending on the drag you set.' });
  }
  notes.push({
    id: 'bench-rover',
    kind: 'bench',
    title: 'On your bench',
    body: 'Weigh it. Measure stall current of the motors you actually bought. Wheel force ≈ motor torque × gear / wheel radius, and torque ≈ Kt × current, and Kt is on the datasheet — or it isn’t, and you measure pull with a luggage scale. This page will not invent that Kt.',
  });
}

function pushWingNotes(config: MachineConfig, notes: Note[], warnings: Warning[]): void {
  const w = config.massKg * G;
  const v = Math.sqrt((2 * w) / Math.max(1e-6, config.airDensity * config.cl * config.wingAreaM2));
  const drag = (config.cd / Math.max(config.cl, 1e-3)) * w;
  notes.push({
    id: 'wing-est',
    kind: 'assumption',
    title: 'Trainer numbers are a sketch',
    body: `No kit was named, so wing area ${fmt(config.wingAreaM2, 2)} m², Cl ${fmt(config.cl, 2)} and Cd ${fmt(config.cd, 2)} are estimates. Cruise speed from L = W is √(2W / (ρ Cl S)) = ${fmt(v, 1)} m/s. Drag at that Cl/Cd is ${fmt(drag, 2)} N, so the prop has to beat that to hold speed. Replace Cl, Cd and area with the wing you will build.`,
    fieldId: 'wingAreaM2',
  });
  notes.push({
    id: 'wing-limit',
    kind: 'limit',
    title: 'The wing is a force the controller applies from airspeed',
    body: 'Lift = ½ρv²ClS, pushed through a thrust actuator along body-up. There is no stall model beyond “lift needs speed”, no propwash, no ground effect. If it diverges, the numbers are still the sizing sheet — the picture is not a flight test.',
  });
  if (config.cruiseThrustN < drag * 0.9) {
    warnings.push({ level: 'warn', text: `Cruise thrust ${fmt(config.cruiseThrustN, 2)} N is under the drag this Cl/Cd implies (${fmt(drag, 2)} N). It will not hold speed in level flight.` });
  }
}

function pushBallisticNotes(config: MachineConfig, notes: Note[], warnings: Warning[]): void {
  const weaponish = /\b(missile|warhead|explosive|bomb)\b/i.test(config.prompt);
  notes.push({
    id: 'ballistic',
    kind: 'assumption',
    title: weaponish ? 'This is an unguided coasting body, not a weapon' : 'Constant thrust, then coast',
    body: weaponish
      ? 'The sentence used a weapon word. The sim is a point mass with a timed thrust and quadratic drag. No guidance, no seeker, no payload, no charge. If that is what you wanted, this page will not build it.'
      : `Thrust ${fmt(config.thrustPerMotorN, 1)} N for ${fmt(config.burnS, 2)} s on ${fmt(config.massKg, 3)} kg, then coast. Average thrust belongs on the motor’s certified label, not in a chat. I did not look up a motor class — the number is a placeholder until you type the impulse you bought.`,
    fieldId: 'thrustPerMotorN',
  });
  notes.push({
    id: 'bench-rocket',
    kind: 'bench',
    title: 'On your side of the table',
    body: 'Model rockets use certified motors, a recovery system, and a range or a club that will have you. This sim ignores wind shear, rod whip, and the law. It answers one question: with the average thrust and mass you typed, how high does a point mass get?',
  });
  if (config.thrustPerMotorN < config.massKg * G && config.thrustAxis === 'up') {
    warnings.push({ level: 'block', text: 'Thrust is below weight. It will not lift off the rod.' });
  }
}

function pushArmNotes(config: MachineConfig, plan: ArmPlan | null, notes: Note[], warnings: Warning[]): void {
  const tauG = ((config.massKg * config.linkLengthM) / 2 + config.payloadKg * config.linkLengthM) * G;
  const avail = config.motorTorqueNm * config.gearRatio;
  notes.push({
    id: 'arm-static',
    kind: 'calc',
    title: 'Holding torque at horizontal',
    body: `τ = (m_link × L/2 + m_payload × L) × g = (${fmt(config.massKg, 3)} × ${fmt(config.linkLengthM / 2, 3)} + ${fmt(config.payloadKg, 3)} × ${fmt(config.linkLengthM, 3)}) × ${G} = ${fmt(tauG, 3)} N·m. Motor × gear = ${fmt(config.motorTorqueNm, 3)} × ${fmt(config.gearRatio, 1)} = ${fmt(avail, 3)} N·m. Margin = ${fmt(avail / Math.max(tauG, 1e-6), 2)}×. A static hold wants margin for acceleration and for the gearbox’s losses, which are not in this number.`,
    fieldId: 'motorTorqueNm',
  });
  notes.push({
    id: 'arm-joint',
    kind: 'limit',
    title: 'The picture is a 1-DOF pendulum, not the rigid-body scene',
    body: 'Velxio’s scene solver has no hinges, so a multi-link arm would be a lie if I drew it as free bodies. This view integrates θ̈ = (τ_motor + τ_gravity) / I for one link, I = mL²/3 + m_payload L². It will not show deflection, backlash, or a wrist.',
  });
  if (avail < tauG) {
    warnings.push({ level: 'block', text: 'Available torque is below the horizontal holding torque. It will sag. Gear up, shorten the link, or pick a motor whose stall torque × ratio clears this with margin.' });
  }
  void plan;
}

function pushStationNotes(config: MachineConfig, notes: Note[], warnings: Warning[]): void {
  const day = 24 - config.nightHours;
  // Average of a half-sine over the day window, then over 24 h, is (2/π) × day/24.
  const avgSolar = config.solarW * (2 / Math.PI) * (day / 24);
  const surplus = avgSolar - config.loadW;
  notes.push({
    id: 'station-budget',
    kind: 'calc',
    title: 'A day of watts',
    body: `Day length ${fmt(day, 1)} h. A half-sine sun averages 2/π of peak over the day window, so mean solar ≈ ${fmt(config.solarW, 2)} × 2/π × ${fmt(day / 24, 2)} = ${fmt(avgSolar, 2)} W. Load is ${fmt(config.loadW, 2)} W. Daily surplus ≈ ${fmt(surplus * 24, 1)} Wh. Battery ${fmt(config.batteryWh, 1)} Wh has to cover the night: load × night = ${fmt(config.loadW * config.nightHours, 1)} Wh. Panel watts are nameplate; a dirty panel, a cloud, and a non-MPPT converter all take a cut this sine wave does not.`,
    fieldId: 'solarW',
  });
  if (config.loadW * config.nightHours > config.batteryWh * 0.8) {
    warnings.push({ level: 'warn', text: 'Night load exceeds 80% of the battery. It will brown out before dawn unless the panel left it full and the night is shorter than you think.' });
  }
  if (surplus < 0) {
    warnings.push({ level: 'block', text: 'Average solar is under the load. No battery size fixes a negative day.' });
  }
  notes.push({
    id: 'bench-station',
    kind: 'bench',
    title: 'On your bench',
    body: 'Measure the load with the radio and the sensor actually running, not the sleep current on the datasheet. Measure panel current at the tilt and hour you will mount it. The sine wave is a teaching clock, not your site’s irradiance.',
  });
}

function benchBody(config: MachineConfig): string {
  if (config.fc === 'arduino-diy') {
    return 'Wire a Nano and an MPU6050 (I²C on A4/A5) only after the props are off. One BEC feeds the Nano — four ESCs each offering 5 V will fight. ESC signal is a 1000–2000 µs pulse; calibrate endpoints before a prop goes on. Motor order in this sim is front-right, front-left, rear-right, rear-left. Your silk screen will not match that until you check it with a smoke-free spin. CodeDroneDIY is a reference for the loop, not a clearance to fly the sketch. Weigh the craft with the pack you will fly. Replace the thrust number.';
  }
  const stack = config.wheelbaseM < 0.16 ? '20×20 mm stack' : '30.5×30.5 mm stack';
  return `Frame, then motors with the prop nuts finger-tight and the props still in the bag. ${stack}, ESC battery pads, capacitor close to those pads, XT${config.cells >= 6 ? '60' : '30'} for a pack this size. Motor wires to M1–M4 in the firmware’s order, not in the order this page drew them — spin each motor with props off and match the map. Flash the firmware, set a hover throttle near the percentage in the calc above, and do not copy our attitude natural-frequency into a Betaflight P gain. They are not the same number. Weigh all-up with the battery latched. Type that mass here. Type the datasheet static thrust here. Then the sim is about your aircraft, not the class.`;
}

function limitText(config: MachineConfig): string {
  if (config.archetype === 'multirotor') {
    return 'The flight is the rigid-body scene: four to eight thrusts at real offsets, prop-reaction yaw, quadratic drag, a ground plane, and a battery that empties from momentum-theory power. It is not Betaflight, not blade-element aerodynamics, not a prop strike, and not your firmware. The editor can run an AVR or an ESP32 sketch against virtual sensors; this page does not. Killing a motor in the scope is the failure case the mixer cannot hide.';
  }
  if (config.archetype === 'arm') return 'One hinged link. No second joint, no compliance, no gearbox efficiency.';
  if (config.archetype === 'station') return 'A 24-hour power clock. No weather, no MPPT curve, no radio duty cycle beyond the load watts you typed.';
  if (config.archetype === 'wing') return 'Point-mass lift from airspeed, attitude held by torque actuators. Not a stall test and not a pattern ship.';
  if (config.archetype === 'ballistic') return 'Constant thrust for the burn you set, then coast under gravity and quadratic drag. No recovery system is simulated — the body comes back down.';
  return 'Two thrusters and a floor. Not a tyre, not a hull survey.';
}

function summary(config: MachineConfig, plan: SimPlan): string {
  if (plan.kind === 'multirotor') {
    return `${config.rotors}-rotor, ${fmt(config.massKg * 1000, 0)} g, hover command ${fmt(plan.hoverFraction * 100, 0)}% if the thrust number is right. Confirm the highlighted fields, then arm.`;
  }
  if (plan.kind === 'surface') return `${config.medium === 'water' ? 'Hull' : 'Rover'}, ${fmt(config.massKg, 2)} kg. Arm and give it throttle.`;
  if (plan.kind === 'wing') return `Trainer sketch. Level-flight speed wants about ${fmt(plan.cruiseSpeed, 1)} m/s. Arm starts it already flying — a wing with no speed is a brick, and the sim says so.`;
  if (plan.kind === 'ballistic') return `Burn ${fmt(config.burnS, 2)} s at ${fmt(config.thrustPerMotorN, 1)} N. Arm, then read the apogee. Change thrust until it matches the motor you will buy.`;
  if (plan.kind === 'arm') return `Holding torque ${fmt(plan.gravityTorque, 2)} N·m, available ${fmt(plan.availableTorque, 2)} N·m. Arm runs the joint up and holds.`;
  return `Panel ${fmt(config.solarW, 1)} W, load ${fmt(config.loadW, 2)} W, battery ${fmt(config.batteryWh, 0)} Wh. Arm runs a day in 24 seconds.`;
}

function metrics(config: MachineConfig, plan: SimPlan): Metric[] {
  if (plan.kind === 'multirotor') {
    const power = hoverPower(config);
    const wh = config.cells * 3.7 * config.mah / 1000;
    return [
      { id: 'tw', label: 'T/W', value: fmt(1 / Math.max(plan.hoverFraction, 1e-6), 2) },
      { id: 'hover', label: 'Hover command', value: `${fmt(plan.hoverFraction * 100, 0)}%` },
      { id: 'disk', label: 'Disc loading', value: `${fmt(diskLoading(config) / G, 2)} kg/m²` },
      { id: 'power', label: 'Hover electrical', value: `${fmt(power.electrical, 0)} W` },
      { id: 'end', label: 'Hover, 20% reserve', value: `${fmt(power.electrical > 0 ? (wh * 0.8 / power.electrical) * 60 : 0, 1)} min` },
      { id: 'pack', label: 'Pack', value: `${fmt(wh, 1)} Wh` },
    ];
  }
  if (plan.kind === 'wing') {
    return [
      { id: 'vcruise', label: 'Cruise speed', value: `${fmt(plan.cruiseSpeed, 1)} m/s` },
      { id: 'wing', label: 'Wing loading', value: `${fmt(config.massKg / Math.max(config.wingAreaM2, 1e-4), 2)} kg/m²` },
    ];
  }
  if (plan.kind === 'arm') {
    return [
      { id: 'tg', label: 'Hold torque', value: `${fmt(plan.gravityTorque, 2)} N·m` },
      { id: 'ta', label: 'Available', value: `${fmt(plan.availableTorque, 2)} N·m` },
    ];
  }
  if (plan.kind === 'station') {
    const day = 24 - config.nightHours;
    const avg = config.solarW * (2 / Math.PI) * (day / 24);
    return [
      { id: 'avg', label: 'Mean solar', value: `${fmt(avg, 2)} W` },
      { id: 'night', label: 'Night load', value: `${fmt(config.loadW * config.nightHours, 1)} Wh` },
    ];
  }
  if (plan.kind === 'ballistic') {
    return [
      { id: 'twb', label: 'Thrust / weight', value: fmt(config.thrustPerMotorN / Math.max(config.massKg * G, 1e-6), 2) },
      { id: 'burn', label: 'Burn', value: `${fmt(config.burnS, 2)} s` },
    ];
  }
  return [
    { id: 'm', label: 'Mass', value: `${fmt(config.massKg, 2)} kg` },
    { id: 'f', label: 'Force / side', value: `${fmt(config.wheelForceN, 1)} N` },
  ];
}

function classCard(config: MachineConfig): ClassCard | null {
  if (config.archetype !== 'multirotor') return null;
  if (config.preset === 'five-freestyle') {
    return {
      title: 'Class card — 5″ freestyle',
      lines: [
        { label: 'Frame', value: '5″ true-X, about 120 g bare, diagonal 210–230 mm', sourceId: 'xteam-5' },
        { label: 'Motor', value: '2207, 1750–1960 KV on 6S (guide example 1960 KV)', sourceId: 'xteam-5' },
        { label: 'Prop', value: '5.0–5.1″ tri-blade, e.g. 5045-3', sourceId: 'xteam-5' },
        { label: 'ESC', value: '45–55 A 4-in-1, ~20% over motor peak', sourceId: 'tdf' },
        { label: 'Pack', value: '6S 1300 mAh, ~100 C on the example build', sourceId: 'xteam-5' },
        { label: 'AUW', value: '600–750 g, example ~620 g with a camera', sourceId: 'uav-5v7' },
        { label: 'Hover throttle', value: '22–28% (published band, not your stick expo)', sourceId: 'uav-5v7' },
        { label: 'Flight time', value: '6–10 min cruise, 3–5 min aggressive — not our hover estimate', sourceId: 'uav-5v7' },
      ],
    };
  }
  if (config.preset === 'seven-lr') {
    return {
      title: 'Class card — 7″ long range',
      lines: [
        { label: 'Motor', value: '2507–2807, 1300–1600 KV, 6S', sourceId: 'uav-kv' },
        { label: 'Prop', value: '7″ bi-blade for range, tri-blade if you want grip', sourceId: 'uav-5v7' },
        { label: 'AUW', value: '800–1100 g', sourceId: 'uav-5v7' },
        { label: 'Hover throttle', value: '15–20%', sourceId: 'uav-5v7' },
        { label: 'Cruise', value: '5–10 A, 18–30 min in the guide’s cruise, not in a hover', sourceId: 'uav-5v7' },
      ],
    };
  }
  if (config.preset === 'arduino-450') {
    return {
      title: 'Class card — published Arduino 450',
      lines: [
        { label: 'Controller', value: 'Arduino Nano / Uno + MPU6050', sourceId: 'codedrone' },
        { label: 'ESC', value: 'Afro 20 A, SimonK, ~1060–1860 µs', sourceId: 'codedrone' },
        { label: 'Motor', value: '2216-800 KV, 20 A max, 2–4S', sourceId: 'codedrone' },
        { label: 'Prop', value: '10×4.5, two CW and two CCW', sourceId: 'codedrone' },
        { label: 'Pack', value: '4S 3000 mAh', sourceId: 'codedrone' },
        { label: 'Frame', value: '450 mm', sourceId: 'codedrone' },
      ],
    };
  }
  if (config.preset === 'whoop' || config.preset === 'first-light') {
    return {
      title: config.preset === 'whoop' ? 'Class card — 2″ whoop' : 'Class card — 3″ toothpick',
      lines: config.preset === 'whoop'
        ? [
            { label: 'AUW', value: '40–60 g', sourceId: 'uav-kv' },
            { label: 'Power', value: '2S, 8000–10000 KV, 1102–1103', sourceId: 'uav-kv' },
          ]
        : [
            { label: 'AUW', value: '100–150 g', sourceId: 'uav-kv' },
            { label: 'Power', value: '3S–4S, 3000–4500 KV, 1303–1404', sourceId: 'uav-kv' },
            { label: 'Frame', value: '3″, diagonal about 120–150 mm', sourceId: 'tdf' },
            { label: 'Pack band', value: '450–850 mAh', sourceId: 'tdf' },
          ],
    };
  }
  return null;
}

function wires(config: MachineConfig): Wire[] {
  if (config.archetype !== 'multirotor') return [];
  if (config.fc === 'arduino-diy') {
    return [
      { from: '4S pack', to: 'ESC battery leads, in parallel', note: 'One pack. Do not series ESCs.' },
      { from: 'One ESC BEC 5 V', to: 'Nano 5V / GND', note: 'Only one BEC. The others stay cut.' },
      { from: 'Nano D3, D5, D6, D9', to: 'ESC signal, props off', note: 'Endpoints 1000–2000 µs before a prop exists.' },
      { from: 'MPU6050 SDA / SCL', to: 'A4 / A5', note: '3.3 V or 5 V as the breakout allows. Not the motor battery.' },
      { from: 'Motor spin', to: 'CW, CCW, CCW, CW around the frame', note: 'Match the map in the scope after a prop-off spin test.' },
    ];
  }
  const xt = config.cells >= 6 ? 'XT60' : 'XT30';
  return [
    { from: `${config.cells}S pack ${xt}`, to: '4-in-1 ESC battery pads', note: 'Capacitor across the pads, leads short.' },
    { from: 'ESC motor pads M1–M4', to: 'Motors, any wire order at first', note: 'Swap two wires to reverse a motor. Do it props-off.' },
    { from: 'ESC signal harness', to: 'FC motor outputs', note: config.wheelbaseM < 0.16 ? '20×20 stack.' : '30.5×30.5 stack.' },
    { from: 'Receiver', to: 'FC UART or SBUS pad', note: 'Bind before the first armed spin.' },
    { from: 'Prop nuts', to: 'The bag, until the map is checked', note: 'The scope’s motor names are not your silk screen.' },
  ];
}

function fieldsFor(config: MachineConfig): FieldSpec[] {
  const common: FieldSpec[] = [];
  const add = (f: FieldSpec) => common.push(f);
  if (config.archetype === 'multirotor') {
    add(num('massKg', 'Airframe', 'All-up mass', 'kg', config, 0.03, 30, 0.01, massWhy(config), massConf(config), 'Weigh it with the pack latched. Class bands are not your aircraft.', ['uav-kv']));
    add(sel('rotors', 'Airframe', 'Rotors', config, [
      { value: '4', label: '4 — quad' },
      { value: '6', label: '6 — hex' },
      { value: '8', label: '8 — octo' },
    ], 'Hex and octo keep flying a motor down. They also add mass and current the class card may not include.'));
    add(num('wheelbaseM', 'Airframe', 'Motor-to-motor diagonal', 'm', config, 0.06, 1.2, 0.01, 'Centre to centre of opposite motors. A 5-inch frame is about 0.21–0.23 m.', 'class-band', 'Measure the frame you bought, not the size printed on the box art.', ['tdf']));
    add(num('propDiameterM', 'Propulsion', 'Prop diameter', 'm', config, 0.03, 0.5, 0.001, 'Disc area sets induced power. A bigger prop on the same KV is how motors overheat.', propConf(config), undefined, ['uav-kv']));
    add(num('thrustPerMotorN', 'Propulsion', 'Static thrust, each motor', 'N', config, 0, 80, 0.05, thrustWhy(config), thrustConf(config), 'Datasheet at your voltage and prop, or a scale under a tied-down arm. This is the number the sim believes.', thrustSources(config)));
    add(num('reactionM', 'Propulsion', 'Prop torque coefficient', 'm', config, 0, 0.08, 0.001, 'Yaw torque per newton of thrust (kq/kt). Opposite spins cancel in hover and make yaw when they differ. Too small and yaw is dead.', 'estimate', 'A thrust stand that also reads torque is the measurement. 0.01–0.02 m is a small-prop estimate.'));
    add(num('cells', 'Power', 'Cells in series', '', config, 1, 12, 1, 'Nominal volts = cells × 3.7 in the endurance math. A 6S pack is not a 4S pack with optimism.', 'cited'));
    add(num('mah', 'Power', 'Capacity', 'mAh', config, 50, 30000, 50, 'The endurance estimate uses 80% of this. A tired pack is not its label.', 'class-band', 'The label is the claim. A discharge test is the number.'));
    add(num('cRating', 'Power', 'C-rating', 'C', config, 1, 200, 1, 'Compared with class peak current. Hobby C-ratings are often a burst figure.', 'estimate'));
    add(num('peakAmpsEach', 'Power', 'Peak current, each motor', 'A', config, 0, 200, 1, '0 means we do not have a cited peak, so the ESC check stays quiet rather than inventing one.', config.peakAmpsEach > 0 ? 'cited' : 'needs-you', 'Motor sheet, full throttle, your prop.', ['xteam-5']));
    add(num('escAmps', 'Power', 'ESC rating, each channel', 'A', config, 0, 200, 1, 'Want about 20% over the motor peak.', config.escAmps > 0 ? 'cited' : 'needs-you', undefined, ['tdf']));
    add(num('figureOfMerit', 'Power', 'Figure of merit', '', config, 0.2, 0.85, 0.01, 'Ideal hover power over electrical-side induced power. 0.42 is a measured small rotor. 0.7 is a helicopter, not your prop.', 'cited', undefined, ['bohorquez', 'momentum']));
    add(num('motorEfficiency', 'Power', 'Motor efficiency', '', config, 0.3, 0.95, 0.01, 'Shaft power over electrical power, folded into the endurance estimate. Not a cited measurement for these classes.', 'estimate'));
    add(num('airDensity', 'Air', 'Air density', 'kg/m³', config, 0.6, 1.4, 0.005, '1.225 is sea level, 15 °C. Belagavi is not sea level — density falls as you climb, hover power rises.', 'estimate', 'Look up the field elevation. Don’t leave 1.225 if you fly at 800 m.'));
    add(num('windMs', 'Air', 'Wind', 'm/s', config, 0, 20, 0.5, 'Constant wind. The position hold has to lean into it. It will not warn you about a gust the way a tree does.', 'estimate'));
    add(num('windFromDeg', 'Air', 'Wind from', 'deg', config, 0, 360, 5, '0 is from the north, so the velocity is toward the south. Meteorological direction.', 'estimate'));
    add(num('hoverAltitudeM', 'Control', 'Hold altitude', 'm', config, 0.3, 40, 0.1, 'The altitude the hold mode climbs to. Not a legal ceiling.', 'estimate'));
    add(num('maxTiltDeg', 'Control', 'Max tilt', 'deg', config, 5, 50, 1, 'Position-hold lean limit. A camera quad wants less. A freestyle quad wants more, and then it is your problem.', 'estimate'));
    add(num('attitudeWn', 'Control', 'Attitude natural frequency', 'rad/s', config, 2, 14, 0.1, 'Gains are wn²×I and 2ζwn×I, ζ ≈ 1. This is not a Betaflight P. It is how stiff the sim’s level-hold is. Raise it and it gets nervous. Lower it and wind wins.', 'estimate'));
    add(num('altitudeWn', 'Control', 'Altitude natural frequency', 'rad/s', config, 0.4, 4, 0.05, 'Same idea on the vertical axis. Too high and it bounces off the command.', 'estimate'));
    add(sel('fc', 'Control', 'Flight controller you will actually build', config, [
      { value: 'betaflight', label: 'Betaflight stack' },
      { value: 'inav', label: 'INAV / GPS hold' },
      { value: 'arduino-diy', label: 'Arduino + MPU6050' },
    ], 'Changes the wiring list and the bench notes. It does not load that firmware into the sim.'));
    add(sel('jurisdiction', 'Where you will fly', 'Jurisdiction', config, [
      { value: 'unset', label: 'Not chosen — I will not guess' },
      { value: 'IN', label: 'India — Drone Rules summary' },
      { value: 'US', label: 'United States — FAA recreational' },
      { value: 'EU', label: 'Europe — read EASA yourself' },
    ], 'A paperwork note from a public page. Not a clearance, not a zone map.'));
  } else if (config.archetype === 'surface') {
    add(num('massKg', 'Chassis', 'Mass', 'kg', config, 0.05, 80, 0.05, 'Weigh the finished rover with its pack.', 'needs-you'));
    add(num('trackM', 'Chassis', 'Track', 'm', config, 0.05, 1.5, 0.01, 'Distance between the two driven wheels. Sets how hard a force difference yaws it.', 'estimate'));
    add(num('wheelForceN', 'Drive', 'Force per wheel', 'N', config, 0.2, 200, 0.1, 'Pull on a scale, or torque × gear / radius from the motor sheet.', 'needs-you'));
    add(num('rollingCoeff', 'Drive', 'Rolling coefficient', '', config, 0, 0.3, 0.005, 'Used as linear drag = Crr × weight, a stand-in for rolling resistance. Carpet is higher than a hard floor.', 'estimate'));
    add(sel('medium', 'Drive', 'Surface', config, [
      { value: 'ground', label: 'Ground' },
      { value: 'water', label: 'Water (floor stands in for the waterline)' },
    ], 'Water adds drag and drops the rolling term. It is still not a hull.'));
    add(num('batteryWh', 'Power', 'Battery', 'Wh', config, 1, 500, 1, 'Drained by mechanical power / 0.55 plus a small idle.', 'estimate'));
  } else if (config.archetype === 'wing') {
    add(num('massKg', 'Airframe', 'Mass', 'kg', config, 0.1, 20, 0.05, 'Ready to fly, with the pack.', 'needs-you'));
    add(num('wingAreaM2', 'Wing', 'Wing area', 'm²', config, 0.05, 2, 0.01, 'Span × mean chord, the wing you will build.', 'estimate'));
    add(num('cl', 'Wing', 'Lift coefficient', '', config, 0.2, 1.6, 0.05, 'Level-flight Cl. A trainer is often near 0.6–0.9. This is not a polar.', 'estimate'));
    add(num('cd', 'Wing', 'Drag coefficient', '', config, 0.02, 0.4, 0.005, 'Referenced to wing area, so it includes the fuselage if you want it to.', 'estimate'));
    add(num('cruiseThrustN', 'Power', 'Max prop thrust', 'N', config, 0.2, 40, 0.1, 'Has to beat drag at the cruise Cl/Cd, with margin to climb.', 'needs-you'));
    add(num('hoverAltitudeM', 'Mission', 'Hold altitude', 'm', config, 2, 80, 1, 'The altitude the throttle loop holds once it has speed.', 'estimate'));
    add(num('windMs', 'Air', 'Wind', 'm/s', config, 0, 15, 0.5, 'Constant. A wing with no airspeed relative to the wind is not flying.', 'estimate'));
  } else if (config.archetype === 'ballistic') {
    add(num('massKg', 'Vehicle', 'Mass', 'kg', config, 0.02, 50, 0.01, 'With the motor, before ignition. A point mass has no CG shift as it burns — another lie, smaller if the motor is a small fraction of the mass.', 'needs-you'));
    add(num('thrustPerMotorN', 'Motor', 'Average thrust', 'N', config, 0, 500, 0.1, 'The certified motor label’s average thrust. Not a guess from a forum.', 'needs-you'));
    add(num('burnS', 'Motor', 'Burn time', 's', config, 0.05, 20, 0.05, 'From the same label.', 'needs-you'));
    add(sel('thrustAxis', 'Motor', 'Thrust axis', config, [
      { value: 'up', label: 'Up — rocket' },
      { value: 'forward', label: 'Forward — catapult' },
    ], 'Up coasts on a ballistic arc. Forward is a shove along the ground.'));
    add(num('airDensity', 'Air', 'Air density', 'kg/m³', config, 0.6, 1.4, 0.005, 'Drag uses this.', 'estimate'));
  } else if (config.archetype === 'arm') {
    add(num('linkLengthM', 'Link', 'Length', 'm', config, 0.05, 1.5, 0.01, 'Pivot to payload.', 'needs-you'));
    add(num('massKg', 'Link', 'Link mass', 'kg', config, 0.02, 10, 0.01, 'Uniform link. Gravity acts at L/2.', 'needs-you'));
    add(num('payloadKg', 'Link', 'Payload', 'kg', config, 0, 10, 0.01, 'At the tip.', 'needs-you'));
    add(num('motorTorqueNm', 'Actuator', 'Motor stall torque', 'N·m', config, 0.01, 20, 0.01, 'Datasheet stall, which you will not hold continuously without cooking the windings.', 'needs-you'));
    add(num('gearRatio', 'Actuator', 'Gear ratio', '', config, 1, 200, 1, 'Torque multiplies. Speed divides. Efficiency does not appear — real gearboxes are worse than this.', 'estimate'));
  } else {
    add(num('solarW', 'Power', 'Panel nameplate', 'W', config, 0, 200, 0.5, 'Peak, full sun, clean, pointed. The day averages 2/π of that over the day window.', 'needs-you'));
    add(num('loadW', 'Power', 'Average load', 'W', config, 0.01, 50, 0.01, 'Measured with the radio on, not the sleep current.', 'needs-you'));
    add(num('batteryWh', 'Power', 'Battery', 'Wh', config, 1, 500, 1, 'Has to cover the night with margin.', 'needs-you'));
    add(num('nightHours', 'Site', 'Night length', 'h', config, 6, 18, 0.5, 'Season and latitude. 12 h is an equinox, not Belagavi in June.', 'estimate'));
  }
  return common;
}

function num(
  id: string, group: string, label: string, unit: string, config: MachineConfig,
  min: number, max: number, step: number, why: string, confidence: Confidence, bench?: string, sourceIds?: string[],
): FieldSpec {
  void config;
  return { id, group, label, unit, kind: 'number', min, max, step, why, confidence, bench, sourceIds };
}

function sel(
  id: string, group: string, label: string, config: MachineConfig,
  options: { value: string; label: string }[], why: string,
): FieldSpec {
  void config;
  return { id, group, label, kind: 'select', options, why, confidence: 'estimate' };
}

function massWhy(config: MachineConfig): string {
  if (config.preset === 'five-freestyle') return 'Example build is about 620 g with a camera. The class band is 600–750 g. Yours is whatever the scale says.';
  if (config.preset === 'seven-lr') return 'Class band 800–1100 g. 950 g is the middle, not a weighing.';
  if (config.preset === 'arduino-450') return 'The reference build does not publish a weight. 1.05 kg is a placeholder.';
  if (config.preset === 'whoop') return 'Class band 40–60 g. 50 g is the middle.';
  return 'Class band 100–150 g for a 3-inch toothpick. 140 g is inside it, not a measurement.';
}

function massConf(config: MachineConfig): Confidence {
  if (config.confirmed.includes('massKg')) return 'needs-you';
  if (config.preset === 'arduino-450') return 'needs-you';
  if (config.preset === 'five-freestyle' || config.preset === 'seven-lr' || config.preset === 'whoop' || config.preset === 'first-light') return 'class-band';
  return 'estimate';
}

function thrustWhy(config: MachineConfig): string {
  if (config.preset === 'five-freestyle') return 'Back-calculated so linearized hover is 25%, the middle of the published 22–28% band, at the example weight. Not a thrust-stand reading.';
  if (config.preset === 'seven-lr') return 'Back-calculated to a 17.5% hover command, inside the published 15–20% band, at 950 g.';
  if (config.preset === 'arduino-450') return 'Not in the reference build. 8.5 N is a placeholder so the sim has a force. Replace it.';
  return 'Not in the class table. Placeholder so the sim can fly. Replace it with your motor at your voltage and prop.';
}

function thrustConf(config: MachineConfig): Confidence {
  if (config.confirmed.includes('thrustPerMotorN')) return 'needs-you';
  if (config.preset === 'five-freestyle' || config.preset === 'seven-lr') return 'class-band';
  return 'needs-you';
}

function thrustSources(config: MachineConfig): string[] | undefined {
  if (config.preset === 'five-freestyle' || config.preset === 'seven-lr') return ['uav-5v7'];
  return undefined;
}

function propConf(config: MachineConfig): Confidence {
  if (config.preset === 'five-freestyle' || config.preset === 'arduino-450') return 'cited';
  return 'class-band';
}

function diskLoading(config: MachineConfig): number {
  const area = Math.PI * (config.propDiameterM / 2) ** 2;
  return (config.massKg * G) / Math.max(config.rotors * area, 1e-8);
}

function hoverPower(config: MachineConfig): { tEach: number; vi: number; ideal: number; electrical: number } {
  const tEach = (config.massKg * G) / Math.max(config.rotors, 1);
  const area = Math.PI * (config.propDiameterM / 2) ** 2;
  const vi = Math.sqrt(tEach / Math.max(2 * config.airDensity * area, 1e-8));
  const ideal = config.rotors * tEach * vi;
  const electrical = ideal / Math.max(0.05, config.figureOfMerit * config.motorEfficiency);
  return { tEach, vi, ideal, electrical };
}

export function compilePlan(config: MachineConfig): SimPlan {
  if (config.archetype === 'multirotor') return compileMulti(config);
  if (config.archetype === 'surface') return compileSurface(config);
  if (config.archetype === 'wing') return compileWing(config);
  if (config.archetype === 'arm') return compileArm(config);
  if (config.archetype === 'station') return compileStation(config);
  return compileBallistic(config);
}

function compileMulti(config: MachineConfig): SimPlan {
  const n = config.rotors;
  const inertia = quadInertia(config.massKg, config.wheelbaseM);
  const mounts = placeRotors(n, config.wheelbaseM).map((m, i) => ({
    ...m,
    id: `m${i + 1}`,
    maxForce: Math.max(0, config.thrustPerMotorN),
  }));
  const belly = 0.028;
  const wind = windVector(config.windMs, config.windFromDeg);
  const frontal = Math.max(0.006, 0.02 * (config.wheelbaseM / 0.22));
  const qDrag = 0.5 * config.airDensity * 1.0 * frontal;
  const scene = mustScene({
    version: 1,
    name: config.name,
    environment: {
      gravity: { x: 0, y: -G, z: 0 },
      wind,
      linearDrag: 0,
      quadraticDrag: qDrag,
      angularDrag: 0.002 * config.massKg,
      floorY: 0,
      restitution: 0.05,
      groundDamping: 6,
    },
    bodies: [{
      id: 'craft',
      label: config.name,
      mass: config.massKg,
      position: { x: 0, y: belly + 0.01, z: 0 },
      inertia,
      shape: { type: 'sphere', radius: belly },
    }],
    actuators: mounts.map((m) => ({
      id: m.id,
      name: m.name,
      bodyId: 'craft',
      kind: 'thrust',
      axis: { x: 0, y: 1, z: 0 },
      maxForce: m.maxForce,
      offset: { x: m.x, y: 0, z: m.z },
      reactionNmPerN: m.spin * config.reactionM,
      timeConstantMs: config.propDiameterM > 0.2 ? 28 : config.propDiameterM > 0.12 ? 18 : 12,
    })),
  });
  const wn = clamp(config.attitudeWn, 2, 14);
  const zeta = 1.05;
  const aw = clamp(config.altitudeWn, 0.4, 4);
  const pw = 0.85;
  const weight = config.massKg * G;
  const hoverFraction = weight / Math.max(n * config.thrustPerMotorN, 1e-6);
  return {
    kind: 'multirotor',
    title: config.name,
    scene,
    mounts,
    mass: config.massKg,
    gravity: G,
    propArea: Math.PI * (config.propDiameterM / 2) ** 2,
    propDiameterM: config.propDiameterM,
    rho: config.airDensity,
    fm: config.figureOfMerit,
    eta: config.motorEfficiency,
    reactionM: config.reactionM,
    attKp: { x: wn * wn * inertia.ix, y: 2 * 0.9 * wn * inertia.iy, z: wn * wn * inertia.iz },
    attKd: { x: 2 * zeta * wn * inertia.ix, y: 0, z: 2 * zeta * wn * inertia.iz },
    altKp: aw * aw * config.massKg,
    altKd: 2 * 1.15 * aw * config.massKg,
    altKi: 0.55 * aw * config.massKg,
    posKp: pw * pw,
    posKd: 2 * 1.15 * pw,
    posKi: 0.45 * pw,
    maxTilt: config.maxTiltDeg * Math.PI / 180,
    hoverAltitude: config.hoverAltitudeM,
    hoverFraction,
    belly,
    energyWh: config.cells * 3.7 * config.mah / 1000,
  };
}

function compileSurface(config: MachineConfig): SimPlan {
  const belly = 0.04;
  const scene = mustScene({
    version: 1,
    name: config.name,
    environment: {
      gravity: { x: 0, y: -G, z: 0 },
      floorY: 0,
      restitution: 0.02,
      groundDamping: 0,
      linearDrag: config.medium === 'water' ? 0.4 : config.rollingCoeff * config.massKg * G,
      quadraticDrag: config.medium === 'water' ? 4 : 0.15,
    },
    bodies: [{
      id: 'craft',
      label: config.name,
      mass: config.massKg,
      position: { x: 0, y: belly + 0.002, z: 0 },
      inertia: { ix: 0.02, iy: config.massKg * config.trackM * config.trackM * 0.3, iz: 0.02 },
      shape: { type: 'sphere', radius: belly },
    }],
    actuators: [
      { id: 'left', name: 'left', bodyId: 'craft', kind: 'thrust', signed: true, axis: { x: 0, y: 0, z: 1 }, maxForce: config.wheelForceN, offset: { x: -config.trackM / 2, y: 0, z: 0 }, timeConstantMs: 40 },
      { id: 'right', name: 'right', bodyId: 'craft', kind: 'thrust', signed: true, axis: { x: 0, y: 0, z: 1 }, maxForce: config.wheelForceN, offset: { x: config.trackM / 2, y: 0, z: 0 }, timeConstantMs: 40 },
    ],
  });
  return {
    kind: 'surface',
    title: config.name,
    scene,
    mass: config.massKg,
    wheelForce: config.wheelForceN,
    track: config.trackM,
    medium: config.medium,
    energyWh: config.batteryWh || config.cells * 3.7 * config.mah / 1000,
  };
}

function compileWing(config: MachineConfig): SimPlan {
  const w = config.massKg * G;
  const cruise = Math.sqrt((2 * w) / Math.max(1e-6, config.airDensity * config.cl * config.wingAreaM2));
  const qDrag = 0.5 * config.airDensity * config.cd * config.wingAreaM2;
  const scene = mustScene({
    version: 1,
    name: config.name,
    environment: {
      gravity: { x: 0, y: -G, z: 0 },
      wind: windVector(config.windMs, config.windFromDeg),
      floorY: 0,
      restitution: 0.05,
      groundDamping: 4,
      quadraticDrag: qDrag,
    },
    bodies: [{
      id: 'craft',
      label: config.name,
      mass: config.massKg,
      position: { x: 0, y: config.hoverAltitudeM, z: 0 },
      velocity: { x: 0, y: 0, z: cruise },
      inertia: { ix: 0.04, iy: 0.05, iz: 0.08 },
      shape: { type: 'sphere', radius: 0.08 },
    }],
    actuators: [
      { id: 'prop', name: 'prop', bodyId: 'craft', kind: 'thrust', axis: { x: 0, y: 0, z: 1 }, maxForce: config.cruiseThrustN, timeConstantMs: 40 },
      { id: 'wing', name: 'wing', bodyId: 'craft', kind: 'thrust', axis: { x: 0, y: 1, z: 0 }, maxForce: w * 3, timeConstantMs: 1 },
      { id: 'pitch', name: 'pitch', bodyId: 'craft', kind: 'torque', signed: true, axis: { x: 1, y: 0, z: 0 }, maxTorque: 1.5, timeConstantMs: 20 },
      { id: 'roll', name: 'roll', bodyId: 'craft', kind: 'torque', signed: true, axis: { x: 0, y: 0, z: 1 }, maxTorque: 1.2, timeConstantMs: 20 },
      { id: 'yaw', name: 'yaw', bodyId: 'craft', kind: 'torque', signed: true, axis: { x: 0, y: 1, z: 0 }, maxTorque: 0.4, timeConstantMs: 20 },
    ],
  });
  return {
    kind: 'wing',
    title: config.name,
    scene,
    mass: config.massKg,
    area: config.wingAreaM2,
    cl: config.cl,
    rho: config.airDensity,
    maxThrust: config.cruiseThrustN,
    maxLift: w * 3,
    hoverAltitude: config.hoverAltitudeM,
    cruiseSpeed: cruise,
    energyWh: config.cells * 3.7 * config.mah / 1000 || 20,
  };
}

function compileBallistic(config: MachineConfig): SimPlan {
  const up = config.thrustAxis === 'up';
  const scene = mustScene({
    version: 1,
    name: config.name,
    environment: {
      gravity: { x: 0, y: -G, z: 0 },
      floorY: 0,
      restitution: 0.15,
      groundDamping: 2,
      quadraticDrag: 0.004 * Math.max(config.cd, 0.2),
    },
    bodies: [{
      id: 'craft',
      label: config.name,
      mass: config.massKg,
      position: { x: 0, y: 0.05, z: 0 },
      shape: { type: 'sphere', radius: 0.04 },
      inertia: { ix: 0.002, iy: 0.002, iz: 0.002 },
    }],
    actuators: [{
      id: 'boost',
      name: 'boost',
      bodyId: 'craft',
      kind: 'thrust',
      axis: up ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 },
      maxForce: config.thrustPerMotorN,
      timeConstantMs: 20,
    }],
  });
  return {
    kind: 'ballistic',
    title: config.name,
    scene,
    burnS: config.burnS,
    thrustN: config.thrustPerMotorN,
    mass: config.massKg,
    axis: config.thrustAxis,
    energyWh: 1,
  };
}

function compileArm(config: MachineConfig): SimPlan {
  const length = config.linkLengthM;
  const inertia = (config.massKg * length * length) / 3 + config.payloadKg * length * length;
  const gravityTorque = (config.massKg * length / 2 + config.payloadKg * length) * G;
  return {
    kind: 'arm',
    title: config.name,
    length,
    linkMass: config.massKg,
    payload: config.payloadKg,
    inertia: Math.max(inertia, 1e-5),
    gravityTorque,
    availableTorque: config.motorTorqueNm * config.gearRatio,
    targetDeg: 35,
    energyWh: 20,
  };
}

function compileStation(config: MachineConfig): SimPlan {
  return {
    kind: 'station',
    title: config.name,
    solarW: config.solarW,
    loadW: config.loadW,
    batteryWh: config.batteryWh,
    nightHours: config.nightHours,
    energyWh: config.batteryWh,
  };
}

function windVector(speed: number, fromDeg: number): { x: number; y: number; z: number } {
  const rad = fromDeg * Math.PI / 180;
  return { x: -speed * Math.sin(rad), y: 0, z: -speed * Math.cos(rad) };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a !== 0 && a < 0.01) return n.toExponential(1);
  return n.toFixed(digits);
}

export function dossierText(config: MachineConfig, dossier: Dossier): string {
  const lines: string[] = [];
  lines.push(`# ${dossier.title}`);
  lines.push('');
  lines.push(dossier.summary);
  lines.push('');
  lines.push(`Prompt: ${config.prompt}`);
  lines.push('');
  lines.push('## Numbers');
  for (const m of dossier.metrics) lines.push(`- ${m.label}: ${m.value}`);
  lines.push('');
  lines.push('## Fields you own');
  for (const f of dossier.fields) {
    const v = (config as unknown as Record<string, unknown>)[f.id];
    lines.push(`- ${f.label}: ${String(v)}${f.unit ? ' ' + f.unit : ''} (${f.confidence}) — ${f.why}`);
  }
  lines.push('');
  lines.push('## Notes');
  for (const n of dossier.notes) lines.push(`### ${n.title}\n${n.body}\n`);
  if (dossier.wires.length) {
    lines.push('## Wiring');
    for (const w of dossier.wires) lines.push(`- ${w.from} → ${w.to}. ${w.note}`);
  }
  lines.push('');
  lines.push('## Sources');
  for (const s of dossier.sources) lines.push(`- ${s.title}: ${s.url} — ${s.usedFor}`);
  lines.push('');
  lines.push('This sheet is a configuration aid. It is not a flight clearance.');
  return lines.join('\n');
}
