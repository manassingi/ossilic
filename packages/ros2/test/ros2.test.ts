import { test } from "node:test";
import assert from "node:assert/strict";
import { Ros2Driver, type Socket } from "../src/index.ts";

const manifest = {
  ossilic: "1", name: "t", version: "1.0.0",
  body: { base: { type: "differential_drive" }, sensors: [{ id: "lidar", type: "lidar2d", rays: 3, fov: Math.PI / 2, range: 5 }, { id: "odom", type: "odometry" }], actuators: [{ id: "wheels", type: "differential_drive" }] },
  brain: { tickHz: 10, nodes: [], edges: [] },
  deploy: { targets: [{ name: "edge", driver: "ros2" }] },
} as any;

// a 360° lidar, 1° per beam, everything 3 m away except one return at +45°
const ranges: Array<number | null> = Array(360).fill(3);
ranges[225] = 0.8; ranges[10] = null;
const robot = {
  "/rover/scan": { angle_min: -Math.PI, angle_increment: Math.PI / 180, range_min: 0.05, ranges },
  "/rover/odom": { pose: { pose: { position: { x: 1, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } } },
};

/** A rosbridge that answers each subscription with one message from `topics`. */
function bridge(topics: Record<string, unknown>, opens = true) {
  const sent: any[] = [];
  const sock: Socket = {
    onopen: null, onmessage: null, onclose: null, onerror: null,
    send(d) {
      const m = JSON.parse(d); sent.push(m);
      if (m.op === "subscribe" && m.topic in topics) setTimeout(() => sock.onmessage?.({ data: JSON.stringify({ op: "publish", topic: m.topic, msg: topics[m.topic] }) }));
    },
    close() { sent.push({ op: "close" }); },
  };
  if (opens) setTimeout(() => sock.onopen?.());
  return { sent, connect: () => sock };
}

test("sensors arrive shaped like the simulator's, placed in the brain's world", async () => {
  const b = bridge(robot);
  const d = new Ros2Driver({ namespace: "/rover", origin: { x: 1, y: 2, theta: Math.PI / 2 } }, b.connect);
  await d.init(manifest);
  assert.deepEqual(b.sent.filter((m) => m.op === "subscribe").map((m) => [m.topic, m.type]), [["/rover/scan", "sensor_msgs/msg/LaserScan"], ["/rover/odom", "nav_msgs/msg/Odometry"]]);
  const scan = d.readSensor("lidar") as { angles: number[]; ranges: number[] };
  assert.deepEqual(scan.ranges, [3, 3, 0.8], "nearest return per ray sector; null beams ignored");
  const p = d.readSensor("odom") as { x: number; y: number; theta: number };
  assert.ok(Math.abs(p.x - 1) < 1e-9 && Math.abs(p.y - 3) < 1e-9 && Math.abs(p.theta - Math.PI / 2) < 1e-9, JSON.stringify(p));
  d.dispose();
});

test("commands publish once per step; letting go stops the motors", async () => {
  const b = bridge(robot);
  const d = new Ros2Driver({ namespace: "/rover" }, b.connect);
  await d.init(manifest);
  d.writeActuator("wheels", { v: 0.4, w: -0.2 });
  const t0 = Date.now();
  await d.step(0.05);
  assert.ok(Date.now() - t0 >= 45, "a step holds its real-time slot");
  d.dispose();
  const pubs = b.sent.filter((m) => m.op === "publish");
  assert.deepEqual(pubs.map((m) => [m.topic, m.msg.linear.x, m.msg.angular.z]), [["/rover/cmd_vel", 0.4, -0.2], ["/rover/cmd_vel", 0, 0]]);
  assert.equal(b.sent.at(-1).op, "close");
});

test("silent topics and an unreachable bridge fail with a fix", async () => {
  const quiet = new Ros2Driver({ namespace: "/rover", timeout: 80 }, bridge({ "/rover/odom": robot["/rover/odom"] }).connect);
  await assert.rejects(quiet.init(manifest), /no messages on \/rover\/scan/);
  const away = new Ros2Driver({ url: "ws://robot:9090", timeout: 50 }, bridge({}, false).connect);
  await assert.rejects(away.init(manifest), /cannot reach rosbridge at ws:\/\/robot:9090.*rosbridge_websocket_launch/);
});
