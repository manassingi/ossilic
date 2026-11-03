/**
 * @ossilic/ros2 — runs a machine on a real robot through rosbridge.
 *
 * The robot runs ROS 2 with rosbridge_server; this driver speaks rosbridge's
 * JSON protocol over a WebSocket, so it works from the CLI and from Desktop
 * without native ROS libraries. Topics are reshaped into exactly what the
 * simulators deliver (a lidar is resampled to the manifest's rays and field of
 * view, odometry is placed in the world through `origin`), so the brain that
 * passed in simulation reads the same ports on hardware.
 */
import type { Driver } from "@ossilic/runtime";
import type { Imu, MachineManifest, Pose, Scan, Twist } from "@ossilic/spec";

export interface Ros2Config {
  /** rosbridge WebSocket, default ws://localhost:9090 */
  url?: string;
  /** Prefix for the default topic names, e.g. "/rover" → /rover/scan, /rover/cmd_vel */
  namespace?: string;
  /** Per component id, a topic that overrides the default name. */
  topics?: Record<string, string>;
  /** Where the robot's odometry frame sits in the world the brain was built for. */
  origin?: Pose;
  /** Milliseconds to wait for the bridge and for each sensor's first message. */
  timeout?: number;
}

/** The part of the WebSocket API the driver uses; the browser's and Node's built-in WebSocket both fit. */
export interface Socket {
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

type Quat = { x: number; y: number; z: number; w: number };
const yaw = (q: Quat) => Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const num = (v: unknown, d: number) => (typeof v === "number" ? v : d);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Body component type → default topic suffix, ROS message type. */
const TOPICS: Record<string, [string, string]> = {
  lidar2d: ["scan", "sensor_msgs/msg/LaserScan"],
  odometry: ["odom", "nav_msgs/msg/Odometry"],
  imu: ["imu", "sensor_msgs/msg/Imu"],
  joint_state: ["joint_states", "sensor_msgs/msg/JointState"],
  differential_drive: ["cmd_vel", "geometry_msgs/msg/Twist"],
  joint_position: ["joint_commands", "std_msgs/msg/Float64MultiArray"],
};

export interface LaserScanMsg { angle_min: number; angle_increment: number; range_min: number; ranges: Array<number | null> }

/** The nearest return in each manifest ray's sector, so obstacles between rays are never lost. Sectors the lidar does not cover read as free. */
export function resampleScan(msg: LaserScanMsg, rays: number, fov: number, range: number): Scan {
  const half = rays > 1 ? fov / (rays - 1) / 2 : fov / 2;
  const angles: number[] = [], ranges: number[] = [];
  for (let k = 0; k < rays; k++) {
    const a = rays === 1 ? 0 : -fov / 2 + (fov * k) / (rays - 1);
    let d = range;
    msg.ranges.forEach((r, i) => {
      if (typeof r === "number" && Number.isFinite(r) && r >= msg.range_min && Math.abs(wrap(msg.angle_min + i * msg.angle_increment - a)) <= half) d = Math.min(d, r);
    });
    angles.push(a); ranges.push(d);
  }
  return { angles, ranges, maxRange: range };
}

export class Ros2Driver implements Driver {
  readonly name = "ros2";
  readonly cfg: Ros2Config;
  distance = 0;
  #connect: (url: string) => Socket;
  #ws: Socket | null = null;
  #latest = new Map<string, any>();
  #sensors = new Map<string, { topic: string; type: string; read: (msg: any) => unknown }>();
  #actuators = new Map<string, { topic: string; type: string; encode: (cmd: any) => unknown; stop: unknown }>();
  #pending = new Map<string, unknown>();
  #odom: string | null = null;
  #pose: Pose | null = null;
  #lost: string | null = null;
  #next = 0;

  constructor(cfg: Ros2Config = {}, connect: (url: string) => Socket = (url) => new WebSocket(url) as unknown as Socket) {
    this.cfg = cfg;
    this.#connect = connect;
  }

  async init(m: MachineManifest): Promise<void> {
    const ns = (this.cfg.namespace ?? "").replace(/\/$/, "");
    const route = (id: string, type: string) => {
      if (!TOPICS[type]) throw new Error(`ros2: no ROS topic mapping for "${type}" (${id})`);
      return { topic: this.cfg.topics?.[id] ?? `${ns}/${TOPICS[type][0]}`, type: TOPICS[type][1] };
    };
    const o = this.cfg.origin ?? { x: 0, y: 0, theta: 0 };
    const place = (p: { x: number; y: number }, th: number): Pose => ({
      x: o.x + p.x * Math.cos(o.theta) - p.y * Math.sin(o.theta), y: o.y + p.x * Math.sin(o.theta) + p.y * Math.cos(o.theta), theta: wrap(o.theta + th),
    });
    for (const s of m.body.sensors) {
      const read = s.type === "lidar2d" ? (msg: LaserScanMsg) => resampleScan(msg, num(s.rays, 16), num(s.fov, Math.PI), num(s.range, 4))
        : s.type === "odometry" ? (msg: any): Pose => place(msg.pose.pose.position, yaw(msg.pose.pose.orientation))
        : s.type === "imu" ? (msg: any): Imu => {
          const q: Quat = msg.orientation, v = msg.angular_velocity, a = msg.linear_acceleration;
          return { roll: Math.atan2(2 * (q.w * q.x + q.y * q.z), 1 - 2 * (q.x * q.x + q.y * q.y)), pitch: Math.asin(Math.max(-1, Math.min(1, 2 * (q.w * q.y - q.z * q.x)))), yaw: yaw(q), gyro: [v.x, v.y, v.z], acc: [a.x, a.y, a.z] };
        }
        : (msg: any): number[] => [...msg.position];
      this.#sensors.set(s.id, { ...route(s.id, s.type), read });
      if (s.type === "odometry") this.#odom ??= s.id;
    }
    for (const a of m.body.actuators) {
      const twist = a.type === "differential_drive";
      const encode = twist ? (t: Twist) => ({ linear: { x: t.v, y: 0, z: 0 }, angular: { x: 0, y: 0, z: t.w } }) : (v: number[]) => ({ layout: { dim: [], data_offset: 0 }, data: [...v] });
      this.#actuators.set(a.id, { ...route(a.id, a.type), encode, stop: twist ? encode({ v: 0, w: 0 }) : null });
    }

    const url = this.cfg.url ?? "ws://localhost:9090", timeout = this.cfg.timeout ?? 5000;
    try {
      const ws = (this.#ws = this.#connect(url));
      await new Promise<void>((resolve, reject) => {
        const fail = () => reject(new Error(`ros2: cannot reach rosbridge at ${url}. On the robot run: ros2 launch rosbridge_server rosbridge_websocket_launch.xml`));
        const t = setTimeout(fail, timeout);
        ws.onopen = () => { clearTimeout(t); resolve(); };
        ws.onerror = () => { clearTimeout(t); fail(); };
      });
      ws.onmessage = (e) => { const msg = JSON.parse(String(e.data)); if (msg.op === "publish") this.#latest.set(msg.topic, msg.msg); };
      ws.onclose = () => { this.#lost = `ros2: lost the connection to ${url}`; };
      for (const s of this.#sensors.values()) this.#send({ op: "subscribe", topic: s.topic, type: s.type, queue_length: 1 });
      for (const a of this.#actuators.values()) this.#send({ op: "advertise", topic: a.topic, type: a.type });
      // every sensor speaks once before the first tick, so the brain never reads an empty port
      for (const deadline = Date.now() + timeout; ;) {
        const silent = [...this.#sensors.values()].filter((s) => !this.#latest.has(s.topic)).map((s) => s.topic);
        if (!silent.length) break;
        if (Date.now() > deadline) throw new Error(`ros2: no messages on ${silent.join(", ")}. Check that the robot publishes them, or map ids to topics in the target's config.topics.`);
        await sleep(20);
      }
    } catch (err) { this.dispose(); throw err; }
    this.#pose = this.#odom ? (this.readSensor(this.#odom) as Pose) : null;
    this.#next = Date.now();
  }

  readSensor(id: string): unknown {
    const s = this.#sensors.get(id);
    if (!s) throw new Error(`ros2: unknown sensor "${id}"`);
    return s.read(this.#latest.get(s.topic));
  }

  writeActuator(id: string, command: unknown): void {
    const a = this.#actuators.get(id);
    if (!a) throw new Error(`ros2: unknown actuator "${id}"`);
    this.#pending.set(a.topic, a.encode(command));
  }

  /** Publish this tick's commands, then hold the tick's slot in real time: hardware cannot run faster than the clock. */
  async step(dt: number): Promise<void> {
    if (this.#lost) throw new Error(this.#lost);
    for (const [topic, msg] of this.#pending) this.#send({ op: "publish", topic, msg });
    this.#pending.clear();
    this.#next = Math.max(Date.now(), this.#next + dt * 1000);
    await sleep(this.#next - Date.now());
    if (this.#odom) {
      const p = this.readSensor(this.#odom) as Pose;
      if (this.#pose) this.distance += Math.hypot(p.x - this.#pose.x, p.y - this.#pose.y);
      this.#pose = p;
    }
  }

  snapshot(): Record<string, unknown> {
    return { ...(this.#pose ? { pose: { ...this.#pose } } : {}), distance: this.distance };
  }

  /** Stop the motors before letting go of the robot. */
  dispose(): void {
    if (!this.#ws) return;
    if (!this.#lost) for (const a of this.#actuators.values()) if (a.stop) this.#send({ op: "publish", topic: a.topic, msg: a.stop });
    this.#ws.onclose = null;
    this.#ws.close();
    this.#ws = null;
  }

  #send(msg: object) { this.#ws?.send(JSON.stringify(msg)); }
}
