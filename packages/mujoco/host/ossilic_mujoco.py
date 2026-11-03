"""
Ossilic driver host for MuJoCo.

Speaks the Ossilic Driver Host Protocol: one JSON object per line on stdin,
one JSON reply per line on stdout. Any language can implement this protocol
to bind a body to a world; this host binds it to MuJoCo.

  {"op":"init","manifest":{...},"config":{...},"dir":"/abs/manifest/dir"}
  {"op":"step","dt":0.05,"commands":{"wheels":{"v":0.3,"w":0}},"frame":true}
"""
import json
import math
import os
import sys

import mujoco
import numpy as np

M32 = 0xFFFFFFFF


def _mix(h, k):
    h = ((h ^ k) * 0x85EBCA6B) & M32
    h ^= h >> 13
    h = (h * 0xC2B2AE35) & M32
    return h ^ (h >> 16)


def key_of(sensor_id):
    """FNV-1a, identical to the engine's keyOf."""
    h = 0x811C9DC5
    for ch in sensor_id:
        h = ((h ^ ord(ch)) * 0x01000193) & M32
    return h


def noise(seed, *keys):
    """Counter-based noise in [0, 1), identical to the engine's noise(): a pure function of
    (seed, tick, sensor, element), so reading or adding sensors never shifts another value."""
    h = _mix(0x9E3779B9, seed & M32)
    for k in keys:
        h = _mix(h, k & M32)
    return h / 4294967296


def rpy(q):
    w, x, y, z = q
    roll = math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y))
    pitch = math.asin(max(-1.0, min(1.0, 2 * (w * y - z * x))))
    yaw = math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
    return roll, pitch, yaw


GEOM_TYPES = {mujoco.mjtGeom.mjGEOM_PLANE: "plane", mujoco.mjtGeom.mjGEOM_SPHERE: "sphere", mujoco.mjtGeom.mjGEOM_CAPSULE: "capsule",
              mujoco.mjtGeom.mjGEOM_CYLINDER: "cylinder", mujoco.mjtGeom.mjGEOM_BOX: "box", mujoco.mjtGeom.mjGEOM_MESH: "mesh",
              mujoco.mjtGeom.mjGEOM_ELLIPSOID: "ellipsoid"}


class World:
    def __init__(self, manifest, config, base_dir):
        body = manifest["body"]
        path = os.path.join(base_dir, body.get("model") or "")
        if not body.get("model"):
            raise ValueError("mujoco driver needs body.model (an MJCF file)")
        self.model = mujoco.MjModel.from_xml_path(path)
        self.data = mujoco.MjData(self.model)
        self.base = self.model.body(body["base"].get("body", 1)).id
        self.base_cfg = body["base"]
        self.robot_bodies = {b for b in range(self.model.nbody) if self._root(b) == self.base}
        self.sensors = {s["id"]: s for s in body["sensors"]}
        self.actuators = {a["id"]: a for a in body["actuators"]}
        self.seed = int(config.get("seed", 1))
        self.tick = 0
        self.lidar_noise = config.get("lidarNoise", 0)
        # domain randomization: scale contact friction and body masses for this episode
        if config.get("frictionScale"):
            self.model.geom_friction[:, 0] *= float(config["frictionScale"])
        if config.get("massScale"):
            self.model.body_mass[:] *= float(config["massScale"])
            self.model.body_inertia[:] *= float(config["massScale"])
        self.collisions = 0
        self.distance = 0.0
        self.ctrl = np.zeros(self.model.nu)
        mujoco.mj_forward(self.model, self.data)
        self.prev_xy = self.data.xpos[self.base][:2].copy()
        for a in self.actuators.values():
            self._actuator_ids(a)  # validate names early

    def _root(self, b):
        while self.model.body_parentid[b] not in (0, b) and self.model.body_parentid[b] != 0:
            b = self.model.body_parentid[b]
        return b

    def _actuator_ids(self, a):
        if a["type"] == "differential_drive":
            return [self.model.actuator(self.base_cfg[k]).id for k in ("left", "right")]
        names = a.get("actuators")
        return [self.model.actuator(n).id for n in names] if names else list(range(self.model.nu))

    # ---- commands ----
    def apply(self, commands):
        for aid, cmd in commands.items():
            a = self.actuators[aid]
            ids = self._actuator_ids(a)
            if a["type"] == "differential_drive":
                L, R, wmax = self.base_cfg["wheelBase"], self.base_cfg["wheelRadius"], self.base_cfg.get("maxWheelSpeed", 1e9)
                wl, wr = (cmd["v"] - cmd["w"] * L / 2) / R, (cmd["v"] + cmd["w"] * L / 2) / R
                s = max(1.0, abs(wl) / wmax, abs(wr) / wmax)
                self.ctrl[ids[0]], self.ctrl[ids[1]] = wl / s, wr / s
            else:
                for i, v in zip(ids, cmd):
                    self.ctrl[i] = v
        self.data.ctrl[:] = self.ctrl

    def step(self, dt):
        self.tick += 1
        n = max(1, round(dt / self.model.opt.timestep))
        hit = False
        for _ in range(n):
            mujoco.mj_step(self.model, self.data)
            hit = hit or self._touching_obstacle()
        if hit:
            self.collisions += 1
        xy = self.data.xpos[self.base][:2]
        self.distance += float(np.linalg.norm(xy - self.prev_xy))
        self.prev_xy = xy.copy()

    def _touching_obstacle(self):
        for c in self.data.contact[: self.data.ncon]:
            b1, b2 = self.model.geom_bodyid[c.geom1], self.model.geom_bodyid[c.geom2]
            robot = (b1 in self.robot_bodies) != (b2 in self.robot_bodies)
            other = c.geom2 if b1 in self.robot_bodies else c.geom1
            if robot and self.model.geom_type[other] != mujoco.mjtGeom.mjGEOM_PLANE:
                return True
        return False

    # ---- sensing ----
    def read(self):
        out = {}
        for sid, s in self.sensors.items():
            t = s["type"]
            if t == "odometry":
                out[sid] = self.pose()
            elif t == "lidar2d":
                out[sid] = self.lidar(s)
            elif t == "imu":
                out[sid] = self.imu()
            elif t == "joint_state":
                names = s.get("joints")
                ids = [self.model.joint(n).id for n in names] if names else [self.model.actuator_trnid[i][0] for i in range(self.model.nu)]
                out[sid] = [float(self.data.qpos[self.model.jnt_qposadr[j]]) for j in ids]
            else:
                raise ValueError(f"unsupported sensor type {t}")
        return out

    def pose(self):
        p = self.data.xpos[self.base]
        return {"x": float(p[0]), "y": float(p[1]), "theta": rpy(self.data.xquat[self.base])[2]}

    def imu(self):
        r, p, y = rpy(self.data.xquat[self.base])
        vel = np.zeros(6)
        mujoco.mj_objectVelocity(self.model, self.data, mujoco.mjtObj.mjOBJ_BODY, self.base, vel, 1)
        acc = np.zeros(6)
        mujoco.mj_rnePostConstraint(self.model, self.data)
        mujoco.mj_objectAcceleration(self.model, self.data, mujoco.mjtObj.mjOBJ_BODY, self.base, acc, 1)
        return {"roll": r, "pitch": p, "yaw": y, "gyro": vel[:3].tolist(), "acc": acc[3:].tolist()}

    def lidar(self, s):
        rays, fov, rng = int(s.get("rays", 16)), float(s.get("fov", math.pi)), float(s.get("range", 4.0))
        origin = self.data.xpos[self.base] + np.array([0, 0, float(s.get("height", 0.1))])
        yaw = rpy(self.data.xquat[self.base])[2]
        geomid = np.zeros(1, dtype=np.int32)
        angles, ranges = [], []
        for k in range(rays):
            a = 0.0 if rays == 1 else -fov / 2 + fov * k / (rays - 1)
            d = np.array([math.cos(yaw + a), math.sin(yaw + a), 0.0])
            dist = mujoco.mj_ray(self.model, self.data, origin, d, None, 1, self.base, geomid)
            while dist >= 0 and self.model.geom_bodyid[geomid[0]] in self.robot_bodies:  # skip our own parts
                origin2 = origin + d * (dist + 1e-3)
                more = mujoco.mj_ray(self.model, self.data, origin2, d, None, 1, self.base, geomid)
                dist = -1 if more < 0 else dist + 1e-3 + more
            dist = rng if dist < 0 or dist > rng else dist
            if self.lidar_noise:
                u = noise(self.seed, self.tick, key_of(s["id"]), k)
                dist = min(rng, max(0.0, dist * (1 + (u * 2 - 1) * self.lidar_noise)))
            angles.append(a)
            ranges.append(float(dist))
        return {"angles": angles, "ranges": ranges, "maxRange": rng}

    def snapshot(self):
        r, p, _ = rpy(self.data.xquat[self.base])
        return {"pose": self.pose(), "height": float(self.data.xpos[self.base][2]), "upright": abs(r) < 1.0 and abs(p) < 1.0,
                "collisions": self.collisions, "distance": self.distance}

    # ---- rendering ----
    def scene(self):
        m = self.model
        geoms = [{"body": int(m.geom_bodyid[g]), "type": GEOM_TYPES.get(m.geom_type[g], "box"), "size": m.geom_size[g].tolist(),
                  "rgba": m.geom_rgba[g].tolist(), "pos": m.geom_pos[g].tolist(), "quat": m.geom_quat[g].tolist()} for g in range(m.ngeom)]
        return {"bodies": [m.body(b).name for b in range(m.nbody)], "geoms": geoms, "timestep": m.opt.timestep}

    def frame(self):
        return np.concatenate([self.data.xpos, self.data.xquat], axis=1).round(5).tolist()


JOINT_TYPES = {0: "free", 1: "ball", 2: "slide", 3: "hinge"}


def inspect(path):
    """What a model file (MJCF or URDF) contains, so an editor can offer sensors and actuators for it."""
    m = mujoco.MjModel.from_xml_path(path)
    joints = [{"name": m.joint(j).name, "type": JOINT_TYPES.get(int(m.jnt_type[j]), "?"), "range": m.jnt_range[j].tolist() if m.jnt_limited[j] else None}
              for j in range(m.njnt) if m.jnt_type[j] != 0]
    actuators = [{"name": m.actuator(a).name, "joint": m.joint(m.actuator_trnid[a][0]).name} for a in range(m.nu)]
    d = mujoco.MjData(m)
    mujoco.mj_forward(m, d)
    return {"bodies": [m.body(b).name for b in range(1, m.nbody)], "joints": joints, "actuators": actuators,
            "root": m.body(1).name if m.nbody > 1 else None, "timestep": m.opt.timestep,
            "mass": float(m.body_subtreemass[1]) if m.nbody > 1 else 0.0, "height": float(d.xpos[1][2]) if m.nbody > 1 else 0.0}


def main():
    world = None
    for line in sys.stdin:
        try:
            msg = json.loads(line)
            if msg["op"] == "init":
                world = World(msg["manifest"], msg.get("config") or {}, msg.get("dir") or ".")
                reply = {"ok": True, "kernel": f"mujoco {mujoco.__version__}", "scene": world.scene(), "sensors": world.read(), "snapshot": world.snapshot(), "frame": world.frame()}
            elif msg["op"] == "inspect":
                reply = {"ok": True, **inspect(msg["path"])}
            elif msg["op"] == "step":
                world.apply(msg.get("commands") or {})
                world.step(float(msg["dt"]))
                reply = {"ok": True, "sensors": world.read(), "snapshot": world.snapshot()}
                if msg.get("frame"):
                    reply["frame"] = world.frame()
            else:
                reply = {"ok": False, "error": f"unknown op {msg.get('op')}"}
        except Exception as e:  # noqa: BLE001 — every failure must reach the client as a reply
            reply = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
