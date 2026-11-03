/**
 * @ossilic/sim — a planar kinematic simulator driver.
 *
 * Deliberately small: a differential-drive base, a 2D lidar and odometry in a
 * bounded world with circular obstacles. It exists so that a machine can be
 * validated end to end in milliseconds before any physics engine or hardware
 * is involved. Higher-fidelity drivers (MuJoCo, Isaac, Gazebo) implement the
 * same Driver interface.
 */
import type { MachineManifest } from "@ossilic/spec";
import { InvalidWorldError, keyOf, noise, type Driver, type Pose, type Scan, type Twist } from "@ossilic/runtime";

export interface Obstacle { x: number; y: number; r: number }
export interface Sim2DConfig {
  bounds?: { w: number; h: number };
  start?: Pose;
  obstacles?: Obstacle[];
  robotRadius?: number;
  /** Fractional noise applied to lidar ranges (0 = deterministic). */
  lidarNoise?: number;
  seed?: number;
}

interface LidarDef { id: string; rays: number; fov: number; range: number }
interface BaseDef { wheelBase: number; wheelRadius: number; maxWheelSpeed: number }

export class Sim2DDriver implements Driver {
  readonly name = "sim2d";
  /** Version 2: counter-based sensor noise. */
  static readonly kernel = "sim2d 2";
  readonly cfg: Required<Sim2DConfig>;
  pose: Pose;
  collisions = 0;
  distanceTravelled = 0;
  #lidars = new Map<string, LidarDef>();
  #odomIds = new Set<string>();
  #base!: BaseDef;
  #driveId = "";
  #cmd: Twist = { v: 0, w: 0 };
  #tick = 0;

  constructor(config: Sim2DConfig = {}) {
    this.cfg = {
      bounds: config.bounds ?? { w: 6, h: 6 },
      start: config.start ?? { x: 0.5, y: 0.5, theta: 0 },
      obstacles: config.obstacles ?? [],
      robotRadius: config.robotRadius ?? 0.18,
      lidarNoise: config.lidarNoise ?? 0,
      seed: config.seed ?? 1,
    };
    this.pose = { ...this.cfg.start };
  }

  init(m: MachineManifest): void {
    if (m.body.base.type !== "differential_drive") throw new Error(`sim2d supports base type "differential_drive", got "${m.body.base.type}"`);
    const b = m.body.base as Record<string, unknown>;
    this.#base = {
      wheelBase: num(b.wheelBase, 0.3), wheelRadius: num(b.wheelRadius, 0.05), maxWheelSpeed: num(b.maxWheelSpeed, 12),
    };
    for (const s of m.body.sensors) {
      if (s.type === "lidar2d") this.#lidars.set(s.id, { id: s.id, rays: num(s.rays, 16), fov: num(s.fov, Math.PI), range: num(s.range, 4) });
      else if (s.type === "odometry") this.#odomIds.add(s.id);
      else throw new Error(`sim2d: unsupported sensor type "${s.type}" (${s.id})`);
    }
    const drive = m.body.actuators.find((a) => a.type === "differential_drive");
    if (!drive) throw new Error("sim2d: body needs a differential_drive actuator");
    this.#driveId = drive.id;
    if (this.#collides(this.pose)) throw new InvalidWorldError(`sim2d: the robot starts inside an obstacle or wall at (${this.pose.x.toFixed(2)}, ${this.pose.y.toFixed(2)})`);
  }

  info() { return { kernel: Sim2DDriver.kernel }; }

  readSensor(id: string): unknown {
    const lidar = this.#lidars.get(id);
    if (lidar) return this.#scan(lidar);
    if (this.#odomIds.has(id)) return { ...this.pose };
    throw new Error(`sim2d: unknown sensor "${id}"`);
  }

  writeActuator(id: string, command: unknown): void {
    if (id !== this.#driveId) throw new Error(`sim2d: unknown actuator "${id}"`);
    const t = command as Twist;
    // convert to wheel speeds, clamp by motor limits, convert back: this is where
    // the body's physical limits bite, exactly as they will on hardware.
    const { wheelBase: L, wheelRadius: R, maxWheelSpeed: wmax } = this.#base;
    let wl = (t.v - (t.w * L) / 2) / R, wr = (t.v + (t.w * L) / 2) / R;
    const scale = Math.max(1, Math.abs(wl) / wmax, Math.abs(wr) / wmax);
    wl /= scale; wr /= scale;
    this.#cmd = { v: (R * (wl + wr)) / 2, w: (R * (wr - wl)) / L };
  }

  step(dt: number): void {
    this.#tick++;
    const { v, w } = this.#cmd;
    const next: Pose = {
      x: this.pose.x + v * Math.cos(this.pose.theta) * dt,
      y: this.pose.y + v * Math.sin(this.pose.theta) * dt,
      theta: Math.atan2(Math.sin(this.pose.theta + w * dt), Math.cos(this.pose.theta + w * dt)),
    };
    if (this.#collides(next)) { this.collisions++; this.pose.theta = next.theta; return; } // blocked: rotate only
    this.distanceTravelled += Math.hypot(next.x - this.pose.x, next.y - this.pose.y);
    this.pose = next;
  }

  snapshot(): Record<string, unknown> {
    return { pose: { ...this.pose }, cmd: { ...this.#cmd }, collisions: this.collisions, distance: this.distanceTravelled };
  }

  #collides(p: Pose): boolean {
    const r = this.cfg.robotRadius;
    if (p.x < r || p.y < r || p.x > this.cfg.bounds.w - r || p.y > this.cfg.bounds.h - r) return true;
    return this.cfg.obstacles.some((o) => Math.hypot(o.x - p.x, o.y - p.y) < o.r + r);
  }

  #scan(l: LidarDef): Scan {
    const angles: number[] = [], ranges: number[] = [];
    for (let k = 0; k < l.rays; k++) {
      const a = l.rays === 1 ? 0 : -l.fov / 2 + (l.fov * k) / (l.rays - 1);
      let d = this.#raycast(this.pose.theta + a, l.range);
      if (this.cfg.lidarNoise > 0) d = Math.min(l.range, Math.max(0, d * (1 + (noise(this.cfg.seed, this.#tick, keyOf(l.id), k) * 2 - 1) * this.cfg.lidarNoise)));
      angles.push(a); ranges.push(d);
    }
    return { angles, ranges, maxRange: l.range };
  }

  #raycast(theta: number, max: number): number {
    const px = this.pose.x, py = this.pose.y, dx = Math.cos(theta), dy = Math.sin(theta);
    let best = max;
    // walls
    for (const [t] of [[dx > 0 ? (this.cfg.bounds.w - px) / dx : dx < 0 ? -px / dx : Infinity], [dy > 0 ? (this.cfg.bounds.h - py) / dy : dy < 0 ? -py / dy : Infinity]]) {
      if (t > 0 && t < best) best = t;
    }
    // circles
    for (const o of this.cfg.obstacles) {
      const fx = px - o.x, fy = py - o.y;
      const b = fx * dx + fy * dy, c = fx * fx + fy * fy - o.r * o.r;
      const disc = b * b - c;
      if (disc < 0) continue;
      const t = -b - Math.sqrt(disc);
      if (t > 0 && t < best) best = t;
    }
    return best;
  }
}

function num(v: unknown, d: number): number { return typeof v === "number" ? v : d; }
