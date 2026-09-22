/**
 * sensors.ts — map a body's physical state onto the *virtual sensor* value
 * shapes the rest of Velxio already speaks.
 *
 * The existing virtual parts have a generic injection API
 * (`dispatchSensorUpdate(componentId, values)`): the MPU6050 expects
 * {accelX..Z in g, gyroX..Z in deg/s} and the GPS NEO-6M expects
 * {lat, lng, altitude, speed}. This module produces exactly those values
 * from a body's state, so a scene's sensor links close the loop without the
 * simulator ever special-casing "drone": any body can feed any virtual
 * sensor, and firmware written for the real part works unchanged.
 */

import type { Vec3 } from './math';
import type { PhysicsSensorLink } from './scene';

/** MPU6050 value shape (accel in g, gyro in deg/s — matches ProtocolParts). */
export interface ImuValues {
  accelX: number;
  accelY: number;
  accelZ: number;
  gyroX: number;
  gyroY: number;
  gyroZ: number;
  temp?: number;
}

/** GPS NEO-6M value shape (matches sensorControlConfig 'gps-neo6m'). */
export interface GpsValues {
  lat: number;
  lng: number;
  altitude: number;
  speed?: number; // m/s over ground
}

/**
 * World convention: X = east, Y = up, Z = north (a local ENU frame around
 * the GPS reference point). 1° of latitude ≈ 111 320 m; longitude is
 * scaled by cos(lat).
 */
const METERS_PER_DEG_LAT = 111_320;

export function bodyToImuValues(
  accel: Vec3, // body frame, in g
  gyro: Vec3,  // body frame, deg/s
): ImuValues {
  return {
    accelX: accel.x,
    accelY: accel.y,
    accelZ: accel.z,
    gyroX: gyro.x,
    gyroY: gyro.y,
    gyroZ: gyro.z,
  };
}

export function bodyToGpsValues(
  position: Vec3,
  velocity: Vec3,
  link: Pick<PhysicsSensorLink, 'refLat' | 'refLng' | 'refAltitude'>,
): GpsValues {
  const cosLat = Math.max(0.01, Math.cos((link.refLat * Math.PI) / 180));
  return {
    lat: link.refLat + position.z / METERS_PER_DEG_LAT,
    lng: link.refLng + position.x / (METERS_PER_DEG_LAT * cosLat),
    altitude: link.refAltitude + position.y,
    speed: Math.hypot(velocity.x, velocity.z),
  };
}

/**
 * Build the per-sensor dispatch table for a scene: given a telemetry tick
 * (body id → imu/gps source data), produce the {sensorId → values} map the
 * caller hands to `dispatchSensorUpdate`. Pure: no imports of the simulator
 * runtime, so it runs identically in Node.
 */
export interface SensorTickInput {
  imu: (bodyId: string) => { accel: Vec3; gyro: Vec3 } | null;
  state: (bodyId: string) => { position: Vec3; velocity: Vec3 } | null;
}

export function sensorLinkValues(
  links: PhysicsSensorLink[],
  input: SensorTickInput,
): Record<string, ImuValues | GpsValues> {
  const out: Record<string, ImuValues | GpsValues> = {};
  for (const link of links) {
    if (link.kind === 'imu') {
      const r = input.imu(link.bodyId);
      if (r) out[link.sensorId] = bodyToImuValues(r.accel, r.gyro);
    } else {
      const s = input.state(link.bodyId);
      if (s) out[link.sensorId] = bodyToGpsValues(s.position, s.velocity, link);
    }
  }
  return out;
}
