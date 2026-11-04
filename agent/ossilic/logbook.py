"""
The Ossilic logbook: an append-only, hash-chained record of what runs on one robot.

Each line is `<sha256 of the entry JSON><TAB><entry JSON>`, and every entry carries the hash of the
one before it, so editing, removing or reordering any entry breaks the chain from that point on.
Syncing to the Hub makes rewriting the whole chain detectable as well.

It records the identity of every declared software component (one hash over its files), every
install, every change that no install recorded, and every intervention: the on-machine record that
EU Machinery Regulation 2023/1230, Annex III 1.1.9 and 1.2.1(f), asks for.
"""
from __future__ import annotations

import fcntl
import getpass
import hashlib
import json
import os
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Iterator

GENESIS = "0" * 64
AGENT = "ossilic-agent 1"


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _files(root: Path) -> list[Path]:
    if root.is_file():
        return [root]
    return sorted(p for p in root.rglob("*") if p.is_file()) if root.is_dir() else []


def _file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def signature(paths: list[str]) -> str:
    """Sizes and modification times: cheap to read, so unchanged files are never re-hashed."""
    h = hashlib.sha256()
    for root in map(Path, paths):
        h.update(f"{root}\0{root.exists()}\n".encode())
        for f in _files(root):
            try:
                st = f.stat()
                h.update(f"{f}\0{st.st_size}\0{st.st_mtime_ns}\n".encode())
            except FileNotFoundError:
                h.update(f"{f}\0gone\n".encode())
    return h.hexdigest()


def tree_hash(paths: list[str]) -> tuple[str, int]:
    """One hash for a component: each file's path inside its root and its content hash, in a fixed order.
    Install locations are left out, so the same software hashes the same on every robot."""
    h, n = hashlib.sha256(), 0
    for i, root in enumerate(map(Path, paths)):
        if not root.exists():
            h.update(f"{i}\0missing\n".encode())
        for f in _files(root):
            rel = "" if f == root else f.relative_to(root).as_posix()
            h.update(f"{i}\0{rel}\0{_file_hash(f)}\n".encode())
            n += 1
    return h.hexdigest(), n


def verify_lines(lines: Iterable[str]) -> dict:
    """Check every hash and every link. Returns ok, the number of good entries, the head and the first problem."""
    prev, n = GENESIS, 0
    for i, line in enumerate(lines, 1):
        digest, tab, text = line.rstrip("\n").partition("\t")
        bad = lambda why: {"ok": False, "entries": n, "head": prev, "problem": f"entry {i} {why}"}
        try:
            e = json.loads(text)
        except ValueError:
            return bad("is not valid JSON")
        if not tab or hashlib.sha256(text.encode()).hexdigest() != digest:
            return bad("was altered: its hash does not match its content")
        if e.get("seq") != i or e.get("prev") != prev:
            return bad("does not follow the entry before it: an entry was removed, inserted or reordered")
        prev, n = digest, i
    return {"ok": True, "entries": n, "head": prev, "problem": None}


def _apply(st: dict, e: dict) -> None:
    """Fold one entry into the cached state: which tree and version each component has now."""
    d, comps = e["data"], st["components"]
    if e["kind"] in ("install", "change"):
        comps[d["component"]] = {"tree": d["tree"], "files": d["files"], "version": d.get("version")}
    elif e["kind"] in ("init", "config"):
        for name, c in d["components"].items():
            was = comps.get(name, {})
            comps[name] = {"tree": c["tree"], "files": c["files"], "version": was.get("version") if was.get("tree") == c["tree"] else None}


def _who() -> str:
    try:
        return getpass.getuser()
    except Exception:
        return "unknown"


def _ci_source() -> str | None:
    if os.environ.get("OSSILIC_SOURCE"):
        return os.environ["OSSILIC_SOURCE"]
    g = os.environ
    if g.get("GITHUB_RUN_ID"):
        return f"{g.get('GITHUB_SERVER_URL', 'https://github.com')}/{g.get('GITHUB_REPOSITORY')}/actions/runs/{g['GITHUB_RUN_ID']}"
    return None


class Logbook:
    """One robot's logbook, in OSSILIC_HOME (default ~/.ossilic)."""

    def __init__(self, home: str | os.PathLike | None = None):
        self.home = Path(home or os.environ.get("OSSILIC_HOME") or Path.home() / ".ossilic")
        self.log = self.home / "logbook.jsonl"
        self._sigs: dict[str, tuple[str, str, int]] = {}
        self._pending: dict[str, tuple[str, float]] = {}

    # storage

    def _read(self, name: str, default):
        try:
            return json.loads((self.home / name).read_text())
        except FileNotFoundError:
            return default

    def _write(self, name: str, value) -> None:
        tmp = self.home / f".{name}.tmp"
        tmp.write_text(json.dumps(value, indent=1, sort_keys=True))
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.home / name)

    @contextmanager
    def _lock(self):
        with open(self.home / ".lock", "a") as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(f, fcntl.LOCK_UN)

    @property
    def config(self) -> dict:
        c = self._read("config.json", None)
        if c is None:
            raise RuntimeError(f"no logbook in {self.home}: run `ossilic init` first")
        return c

    def state(self) -> dict:
        return self._read("state.json", None) or self._rebuild()

    def _rebuild(self) -> dict:
        st = {"seq": 0, "head": GENESIS, "components": {}, "synced": 0, "assigned": {}}
        for e in self.entries():
            st.update(seq=e["seq"], head=e["hash"])
            _apply(st, e)
        return st

    def lines(self, after: int = 0, limit: int | None = None) -> list[str]:
        if not self.log.exists():
            return []
        with self.log.open(encoding="utf-8") as f:
            out = [line.rstrip("\n") for i, line in enumerate(f, 1) if i > after]
        return out[:limit] if limit else out

    def entries(self) -> Iterator[dict]:
        for line in self.lines():
            digest, _, text = line.partition("\t")
            yield {**json.loads(text), "hash": digest}

    def verify(self) -> dict:
        return verify_lines(self.lines())

    # recording

    def append(self, kind: str, **data) -> dict:
        robot = self.config["robot"]
        with self._lock():
            st = self.state()
            entry = {"seq": st["seq"] + 1, "at": utcnow(), "robot": robot, "kind": kind,
                     "data": {k: v for k, v in data.items() if v is not None}, "prev": st["head"]}
            text = json.dumps(entry, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            digest = hashlib.sha256(text.encode()).hexdigest()
            with self.log.open("a", encoding="utf-8") as f:
                f.write(f"{digest}\t{text}\n")
                f.flush()
                os.fsync(f.fileno())
            st.update(seq=entry["seq"], head=digest)
            _apply(st, entry)
            self._write("state.json", st)
        return {**entry, "hash": digest}

    def init(self, robot: str, site: str | None = None, components: dict[str, list[str]] | None = None,
             hub: str | None = None, token: str | None = None) -> dict:
        """Start a logbook, or record a configuration change in an existing one."""
        self.home.mkdir(parents=True, exist_ok=True, mode=0o700)
        old = self._read("config.json", None)
        if old and old["robot"] != robot:
            raise RuntimeError(f"{self.home} already holds the logbook of robot {old['robot']}")
        cfg = {**(old or {}), "robot": robot, "site": site or (old or {}).get("site"),
               "components": {**(old or {}).get("components", {}), **(components or {})}}
        if hub:
            cfg["hub"] = hub.rstrip("/")
        if token:
            cfg["token"] = token
        self._write("config.json", cfg)
        ident = {}
        for name, paths in cfg["components"].items():
            tree, files = tree_hash(paths)
            ident[name] = {"paths": paths, "tree": tree, "files": files}
        return self.append("config" if old else "init", agent=AGENT, site=cfg["site"], components=ident)

    def identify(self) -> dict:
        """What every declared component is right now. Trees are re-hashed only when their files changed."""
        out = {}
        for name, paths in self.config["components"].items():
            sig, cached = signature(paths), self._sigs.get(name)
            if not cached or cached[0] != sig:
                cached = (sig, *tree_hash(paths))
                self._sigs[name] = cached
            out[name] = {"tree": cached[1], "files": cached[2]}
        return out

    def install(self, component: str, version: str, by: str | None = None, source: str | None = None, note: str | None = None) -> dict:
        """Record that `version` of a component is now installed: call it right after deploying."""
        paths = self.config["components"].get(component)
        if paths is None:
            raise KeyError(f"unknown component {component!r}: declare it with `ossilic init --component {component}=PATH`")
        tree, files = tree_hash(paths)
        before = self.state()["components"].get(component, {})
        return self.append("install", component=component, version=str(version), tree=tree, files=files,
                           previous=before.get("version"), by=by or _who(), source=source or _ci_source(), note=note)

    def intervention(self, kind: str, by: str | None = None, note: str | None = None) -> dict:
        """An emergency stop, a remote takeover, a manual override: anything that steps in on the robot."""
        return self.append("intervention", type=kind, by=by or _who(), note=note)

    def check(self, grace: float = 60.0, clock=time.monotonic) -> list[dict]:
        """Record components whose files changed with no install recorded. A change must last `grace`
        seconds first, so a deploy that records its install right after copying files is never flagged."""
        recorded, logged = self.state()["components"], []
        for name, now in self.identify().items():
            if recorded.get(name, {}).get("tree") == now["tree"]:
                self._pending.pop(name, None)
                continue
            seen = self._pending.get(name)
            if not seen or seen[0] != now["tree"]:
                self._pending[name] = (now["tree"], clock())
                if grace > 0:
                    continue
            if clock() - self._pending[name][1] >= grace:
                logged.append(self.append("change", component=name, tree=now["tree"], files=now["files"],
                                          previous=recorded.get(name, {}).get("tree"), declared=False))
                del self._pending[name]
        return logged

    # fleet data

    def count(self, name: str, value: float = 1.0) -> None:
        """Add to an outcome counter (tasks, failures, interventions, active hours...) for this hour and the
        versions running now. Counters go to the Hub with the logbook and drive live rollouts."""
        versions = {n: c.get("version") for n, c in self.state()["components"].items()}
        key = f"{utcnow()[:13]}|{json.dumps(versions, sort_keys=True)}"
        with self._lock():
            buckets = self._read("counters.json", {})
            bucket = buckets.setdefault(key, {})
            bucket[name] = bucket.get(name, 0) + value
            self._write("counters.json", buckets)

    def take_counters(self) -> dict:
        with self._lock():
            buckets = self._read("counters.json", {})
            self._write("counters.json", {})
        return buckets

    def put_back_counters(self, buckets: dict) -> None:
        """Return counters that could not be sent, adding to anything counted meanwhile."""
        with self._lock():
            now = self._read("counters.json", {})
            for key, bucket in buckets.items():
                for name, v in bucket.items():
                    now.setdefault(key, {})[name] = now.get(key, {}).get(name, 0) + v
            self._write("counters.json", now)

    def mark_synced(self, seq: int, assigned: dict) -> None:
        with self._lock():
            st = self.state()
            st.update(synced=seq, assigned=assigned)
            self._write("state.json", st)

    def assigned(self, component: str) -> str | None:
        """The version the Hub wants on this robot (a rollout or a rollback), else the version installed."""
        st = self.state()
        return st.get("assigned", {}).get(component) or st["components"].get(component, {}).get("version")
