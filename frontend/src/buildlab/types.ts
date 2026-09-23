/**
 * Build lab — the numbers a person has to own before a machine is real.
 *
 * The researcher fills a MachineConfig from a prompt. The human edits it.
 * derive() turns that config into a dossier (what we read, what we assumed,
 * what they still have to measure) and a SimPlan the page can fly.
 */

export type Archetype = 'multirotor' | 'surface' | 'wing' | 'ballistic' | 'arm' | 'station';

export type Jurisdiction = 'unset' | 'IN' | 'US' | 'EU';
export type FcChoice = 'betaflight' | 'inav' | 'arduino-diy';
export type Confidence = 'cited' | 'class-band' | 'estimate' | 'needs-you';

export interface MachineConfig {
  archetype: Archetype;
  preset: string;
  name: string;
  prompt: string;
  massKg: number;
  rotors: 4 | 6 | 8;
  wheelbaseM: number;
  propDiameterM: number;
  thrustPerMotorN: number;
  reactionM: number;
  cells: number;
  mah: number;
  cRating: number;
  figureOfMerit: number;
  motorEfficiency: number;
  airDensity: number;
  windMs: number;
  windFromDeg: number;
  hoverAltitudeM: number;
  maxTiltDeg: number;
  jurisdiction: Jurisdiction;
  fc: FcChoice;
  attitudeWn: number;
  altitudeWn: number;
  trackM: number;
  wheelForceN: number;
  rollingCoeff: number;
  medium: 'ground' | 'water';
  wingAreaM2: number;
  cl: number;
  cd: number;
  cruiseThrustN: number;
  burnS: number;
  thrustAxis: 'up' | 'forward';
  linkLengthM: number;
  payloadKg: number;
  gearRatio: number;
  motorTorqueNm: number;
  solarW: number;
  loadW: number;
  batteryWh: number;
  nightHours: number;
  /** Cited full-throttle current per motor, or 0 if we don't have one. */
  peakAmpsEach: number;
  /** Cited ESC rating, or 0 if unknown. */
  escAmps: number;
  confirmed: string[];
}

export interface Source {
  id: string;
  title: string;
  url: string;
  usedFor: string;
}

export interface Note {
  id: string;
  kind: 'research' | 'calc' | 'assumption' | 'question' | 'warning' | 'bench' | 'limit';
  title: string;
  body: string;
  sourceIds?: string[];
  fieldId?: string;
}

export interface FieldSpec {
  id: string;
  group: string;
  label: string;
  unit?: string;
  kind: 'number' | 'select';
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  why: string;
  confidence: Confidence;
  sourceIds?: string[];
  bench?: string;
}

export interface Wire {
  from: string;
  to: string;
  note: string;
}

export interface ClassCard {
  title: string;
  lines: { label: string; value: string; sourceId?: string }[];
}

export interface Warning {
  level: 'info' | 'warn' | 'block';
  text: string;
}

export interface Metric {
  id: string;
  label: string;
  value: string;
  detail?: string;
}

export interface Dossier {
  title: string;
  summary: string;
  archetype: Archetype;
  fields: FieldSpec[];
  notes: Note[];
  sources: Source[];
  warnings: Warning[];
  metrics: Metric[];
  wires: Wire[];
  classCard: ClassCard | null;
  plan: SimPlan;
}

export interface MotorMount {
  id: string;
  name: string;
  x: number;
  z: number;
  spin: 1 | -1;
  maxForce: number;
}

interface PlanBase {
  title: string;
  energyWh: number;
}

export interface MultiPlan extends PlanBase {
  kind: 'multirotor';
  scene: import('../simulation/physics').PhysicsScene;
  mounts: MotorMount[];
  mass: number;
  gravity: number;
  propArea: number;
  propDiameterM: number;
  rho: number;
  fm: number;
  eta: number;
  reactionM: number;
  attKp: { x: number; y: number; z: number };
  attKd: { x: number; y: number; z: number };
  altKp: number;
  altKd: number;
  altKi: number;
  posKp: number;
  posKd: number;
  posKi: number;
  maxTilt: number;
  hoverAltitude: number;
  hoverFraction: number;
  belly: number;
}

export interface SurfacePlan extends PlanBase {
  kind: 'surface';
  scene: import('../simulation/physics').PhysicsScene;
  mass: number;
  wheelForce: number;
  track: number;
  medium: 'ground' | 'water';
}

export interface WingPlan extends PlanBase {
  kind: 'wing';
  scene: import('../simulation/physics').PhysicsScene;
  mass: number;
  area: number;
  cl: number;
  rho: number;
  maxThrust: number;
  maxLift: number;
  hoverAltitude: number;
  cruiseSpeed: number;
}

export interface BallisticPlan extends PlanBase {
  kind: 'ballistic';
  scene: import('../simulation/physics').PhysicsScene;
  burnS: number;
  thrustN: number;
  mass: number;
  axis: 'up' | 'forward';
}

export interface ArmPlan extends PlanBase {
  kind: 'arm';
  length: number;
  linkMass: number;
  payload: number;
  inertia: number;
  gravityTorque: number;
  availableTorque: number;
  targetDeg: number;
}

export interface StationPlan extends PlanBase {
  kind: 'station';
  solarW: number;
  loadW: number;
  batteryWh: number;
  nightHours: number;
}

export type SimPlan = MultiPlan | SurfacePlan | WingPlan | BallisticPlan | ArmPlan | StationPlan;

export interface Stick {
  roll: number;
  pitch: number;
  yaw: number;
  /** 0..1. Manual collective, or cruise throttle for a rover. */
  throttle: number;
  mode: 'hold' | 'manual' | 'mission';
}

export const EXAMPLES: { prompt: string; note: string }[] = [
  { prompt: 'I wanna build a drone', note: 'We assume a light first aircraft, and we say so' },
  { prompt: '5-inch freestyle quad on 6S', note: 'The build the hobby guides actually specify' },
  { prompt: 'sub-250g camera drone I can fly in India', note: 'Weight class, plus the DGCA paperwork line' },
  { prompt: 'Arduino drone from scratch, 450mm', note: 'Nano, MPU6050, the reference 450' },
  { prompt: 'a small rover that drives across the bench', note: 'Two driven wheels, a floor, a stop' },
  { prompt: 'a model rocket', note: 'Thrust, coast, apogee — not a motor certificate' },
];
