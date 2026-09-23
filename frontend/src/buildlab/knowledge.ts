/**
 * What the lab is allowed to claim.
 *
 * Cited numbers come from the pages in SOURCES. A class band is a range those
 * pages published, and we take a midpoint only when we say that's what we did.
 * Anything else is an estimate or a blank the human has to fill from a
 * datasheet or a scale. The sim will fly either way — the dossier is what
 * stops a placeholder from pretending to be a measurement.
 */

import type { FcChoice, Jurisdiction, MachineConfig, Source } from './types';

export const G = 9.81;

export const SOURCES: Source[] = [
  {
    id: 'uav-5v7',
    title: 'UAVMODEL — 5-inch vs 7-inch FPV build (2026)',
    url: 'https://blog.uavmodel.com/5-inch-vs-7-inch-fpv-build-flight-characteristics-efficiency-and-component-selection-2026-guide/',
    usedFor: 'Class AUW, KV, battery, hover-throttle bands, cruise current, flight-time bands',
  },
  {
    id: 'xteam-5',
    title: 'X-TEAM — 5-inch freestyle motor, ESC and prop guide',
    url: 'https://www.x-teamrc.com/5-inch-freestyle-racing-build-guide-motor-esc-props/',
    usedFor: 'One concrete 6S freestyle stack: frame mass, 2207 1960KV, 55A ESC, 5045-3, 1300 mAh, ~620 g',
  },
  {
    id: 'uav-kv',
    title: 'UAVMODEL — motor KV by build size (2026)',
    url: 'https://blog.uavmodel.com/fpv-motor-kv-selection-4s-vs-6s-matching-guide-for-every-build-type-2026-guide/',
    usedFor: 'Whoop through 7-inch: stator, KV, cell count, AUW bands',
  },
  {
    id: 'tdf',
    title: 'TheDroneFlight — component compatibility',
    url: 'https://thedroneflight.com/blogs/news/fpv-drone-component-compatibility-guide-motors-escs-flight-controllers-more',
    usedFor: 'Frame diagonal vs motor class, ESC headroom of about 20%, stack mounting, pack capacity bands',
  },
  {
    id: 'dji-mini3',
    title: 'DJI Mini 3 specifications',
    url: 'https://www.dji.com/mini-3/specs',
    usedFor: 'What a finished 248 g camera aircraft weighs and how long the maker claims in a wind tunnel — a ceiling, not a DIY bill of materials',
  },
  {
    id: 'codedrone',
    title: 'CodeDroneDIY — Arduino Nano flight controller',
    url: 'https://github.com/liourej/CodeDroneDIY',
    usedFor: 'A published 450 mm learning stack: Nano, MPU6050, 2216-800KV, 10×4.5, Afro 20A, 4S 3000 mAh',
  },
  {
    id: 'momentum',
    title: 'Momentum theory hover power',
    url: 'https://aviation.stackexchange.com/questions/100774/are-there-equations-to-match-power-required-to-mass-for-rotorcraft',
    usedFor: 'P = T √(T / (2 ρ A)) / FM. Figure of merit near 0.7 is a full-size rotor, not a 5-inch prop',
  },
  {
    id: 'bohorquez',
    title: 'Bohorquez — hover performance of a rotary-wing MAV',
    url: 'http://sites.utexas.edu/sirohi/files/2017/07/004_bohorquez_03_jimss.pdf',
    usedFor: 'A measured small-rotor figure of merit of 0.42. Our small-prop default sits next to that, not next to a helicopter',
  },
  {
    id: 'dgca',
    title: 'Public summaries of India’s Drone Rules, 2021',
    url: 'https://blog.uavmodel.com/india-dgca-drone-regulations-2026-digital-sky-platform-uin-uaop-five-categories-zone-system/',
    usedFor: 'Weight categories (nano under 250 g, micro to 2 kg, small to 25 kg). Confirm on Digital Sky — this is not legal advice',
  },
  {
    id: 'faa',
    title: 'FAA — Recreational flyers',
    url: 'https://www.faa.gov/uas/recreational_flyers',
    usedFor: 'Register at 250 g and above, TRUST for recreational flying, 400 ft in Class G. Confirm on the FAA page before you fly',
  },
];

export function sourceById(id: string): Source | undefined {
  return SOURCES.find((s) => s.id === id);
}

export function baseConfig(prompt: string): MachineConfig {
  return {
    archetype: 'multirotor',
    preset: 'first-light',
    name: 'Untitled machine',
    prompt,
    massKg: 0.14,
    rotors: 4,
    wheelbaseM: 0.14,
    propDiameterM: 0.0762,
    thrustPerMotorN: 2.45,
    reactionM: 0.012,
    cells: 4,
    mah: 650,
    cRating: 75,
    figureOfMerit: 0.45,
    motorEfficiency: 0.7,
    airDensity: 1.225,
    windMs: 2,
    windFromDeg: 0,
    hoverAltitudeM: 1.4,
    maxTiltDeg: 20,
    jurisdiction: 'unset',
    fc: 'betaflight',
    attitudeWn: 6,
    altitudeWn: 1.35,
    trackM: 0.16,
    wheelForceN: 4,
    rollingCoeff: 0.03,
    medium: 'ground',
    wingAreaM2: 0.28,
    cl: 0.7,
    cd: 0.08,
    cruiseThrustN: 2.2,
    burnS: 1.6,
    thrustAxis: 'up',
    linkLengthM: 0.32,
    payloadKg: 0.1,
    gearRatio: 5,
    motorTorqueNm: 0.18,
    solarW: 6,
    loadW: 0.35,
    batteryWh: 20,
    nightHours: 12,
    peakAmpsEach: 0,
    escAmps: 0,
    confirmed: [],
  };
}

/** Published class, not a shopping list. Thrust is filled by the caller. */
export function applyPreset(id: string, prompt: string): MachineConfig {
  const c = baseConfig(prompt);
  c.preset = id;
  switch (id) {
    case 'whoop':
      c.name = '2″ whoop';
      c.massKg = 0.05;
      c.wheelbaseM = 0.085;
      c.propDiameterM = 0.0508;
      c.thrustPerMotorN = 0.55;
      c.reactionM = 0.006;
      c.cells = 2;
      c.mah = 300;
      c.cRating = 75;
      c.figureOfMerit = 0.42;
      c.fc = 'betaflight';
      c.maxTiltDeg = 25;
      c.windMs = 0;
      c.hoverAltitudeM = 1;
      c.peakAmpsEach = 0;
      c.escAmps = 0;
      break;
    case 'first-light':
      c.name = '3″ first aircraft';
      c.massKg = 0.14;
      c.wheelbaseM = 0.14;
      c.propDiameterM = 0.0762;
      c.thrustPerMotorN = 2.45;
      c.reactionM = 0.01;
      c.cells = 4;
      c.mah = 650;
      c.cRating = 75;
      c.figureOfMerit = 0.45;
      c.maxTiltDeg = 20;
      c.windMs = 2;
      c.fc = 'betaflight';
      break;
    case 'five-freestyle':
      c.name = '5″ freestyle';
      c.massKg = 0.62;
      c.wheelbaseM = 0.22;
      c.propDiameterM = 0.1295;
      c.cells = 6;
      c.mah = 1300;
      c.cRating = 100;
      c.figureOfMerit = 0.5;
      c.motorEfficiency = 0.75;
      c.reactionM = 0.016;
      c.maxTiltDeg = 30;
      c.windMs = 3;
      c.hoverAltitudeM = 2;
      c.fc = 'betaflight';
      c.peakAmpsEach = 40;
      c.escAmps = 55;
      // Linearized hover command at the midpoint of the published 22–28% band.
      c.thrustPerMotorN = (c.massKg * G / 4) / 0.25;
      break;
    case 'seven-lr':
      c.name = '7″ long range';
      c.massKg = 0.95;
      c.wheelbaseM = 0.28;
      c.propDiameterM = 0.1778;
      c.cells = 6;
      c.mah = 3000;
      c.cRating = 40;
      c.figureOfMerit = 0.55;
      c.reactionM = 0.02;
      c.maxTiltDeg = 22;
      c.windMs = 4;
      c.hoverAltitudeM = 2.5;
      c.fc = 'inav';
      c.peakAmpsEach = 0;
      c.escAmps = 45;
      c.thrustPerMotorN = (c.massKg * G / 4) / 0.175;
      break;
    case 'arduino-450':
      c.name = 'Arduino 450';
      c.massKg = 1.05;
      c.wheelbaseM = 0.45;
      c.propDiameterM = 0.254;
      c.thrustPerMotorN = 8.5;
      c.reactionM = 0.02;
      c.cells = 4;
      c.mah = 3000;
      c.cRating = 25;
      c.figureOfMerit = 0.5;
      c.maxTiltDeg = 15;
      c.windMs = 2;
      c.hoverAltitudeM = 1.2;
      c.attitudeWn = 4.5;
      c.fc = 'arduino-diy';
      c.peakAmpsEach = 20;
      c.escAmps = 20;
      break;
    case 'rover':
      c.archetype = 'surface';
      c.medium = 'ground';
      c.name = 'Bench rover';
      c.massKg = 0.85;
      c.trackM = 0.16;
      c.wheelForceN = 4;
      c.rollingCoeff = 0.04;
      c.batteryWh = 20;
      c.cells = 3;
      c.mah = 2200;
      break;
    case 'boat':
      c.archetype = 'surface';
      c.medium = 'water';
      c.name = 'Small hull';
      c.massKg = 1.4;
      c.trackM = 0.22;
      c.wheelForceN = 6;
      c.rollingCoeff = 0.01;
      c.batteryWh = 40;
      break;
    case 'trainer-wing':
      c.archetype = 'wing';
      c.name = 'Trainer wing';
      c.massKg = 0.75;
      c.wingAreaM2 = 0.28;
      c.cl = 0.7;
      c.cd = 0.08;
      c.cruiseThrustN = 2.4;
      c.hoverAltitudeM = 12;
      c.cells = 3;
      c.mah = 2200;
      c.windMs = 1;
      break;
    case 'model-rocket':
      c.archetype = 'ballistic';
      c.thrustAxis = 'up';
      c.name = 'Model rocket';
      c.massKg = 0.12;
      c.thrustPerMotorN = 6;
      c.burnS = 1.5;
      c.cd = 0.6;
      break;
    case 'catapult':
      c.archetype = 'ballistic';
      c.thrustAxis = 'forward';
      c.name = 'Catapult shot';
      c.massKg = 0.2;
      c.thrustPerMotorN = 40;
      c.burnS = 0.15;
      break;
    case 'weather-station':
      c.archetype = 'station';
      c.name = 'Weather station';
      c.solarW = 6;
      c.loadW = 0.35;
      c.batteryWh = 20;
      c.nightHours = 12;
      break;
    case 'bench-arm':
      c.archetype = 'arm';
      c.name = 'Single-link arm';
      c.linkLengthM = 0.32;
      c.massKg = 0.18;
      c.payloadKg = 0.1;
      c.gearRatio = 5;
      c.motorTorqueNm = 0.18;
      break;
    default:
      c.archetype = 'ballistic';
      c.preset = 'generic-body';
      c.name = 'Single body';
      c.thrustAxis = 'up';
      c.massKg = 1;
      c.thrustPerMotorN = 15;
      c.burnS = 2;
      break;
  }
  return c;
}

export function jurisdictionFromText(text: string): Jurisdiction | null {
  if (/\b(india|indian|dgca|digital sky|belagavi|belgaum|karnataka)\b/i.test(text)) return 'IN';
  if (/\b(faa|united states|u\.s\.a|usa|america)\b/i.test(text)) return 'US';
  if (/\b(easa|europe|eu open category|european)\b/i.test(text)) return 'EU';
  return null;
}

export function fcFromText(text: string): FcChoice | null {
  if (/\b(arduino|nano|from scratch|diy fc|atmega)\b/i.test(text)) return 'arduino-diy';
  if (/\binav\b/i.test(text)) return 'inav';
  if (/\b(betaflight|blheli)\b/i.test(text)) return 'betaflight';
  return null;
}
