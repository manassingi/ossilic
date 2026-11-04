"""`ossilic`: the logbook on a robot. Run `ossilic --help` for the commands."""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from . import hub
from .logbook import AGENT, Logbook, utcnow, verify_lines


def _components(specs: list[str]) -> dict[str, list[str]]:
    out = {}
    for spec in specs:
        name, eq, paths = spec.partition("=")
        if not eq or not name or not paths:
            raise SystemExit(f"--component takes NAME=PATH[,PATH...], not {spec!r}")
        out[name] = [str(Path(p).expanduser().resolve()) for p in paths.split(",")]
    return out


def _detail(e: dict) -> str:
    d = e["data"]
    if e["kind"] in ("init", "config"):
        return "; ".join(f"{n}: tree {c['tree'][:8]} ({c['files']} files)" for n, c in d["components"].items()) or "no components"
    if e["kind"] == "install":
        return (f"{d['component']} {d.get('previous', '?')} -> {d['version']}, tree {d['tree'][:8]}, by {d.get('by', '?')}"
                + (f", from {d['source']}" if d.get("source") else "") + (f": {d['note']}" if d.get("note") else ""))
    if e["kind"] == "change":
        return f"{d['component']} files changed with no install recorded, tree {str(d.get('previous'))[:8]} -> {d['tree'][:8]}"
    if e["kind"] == "intervention":
        return f"{d['type']} by {d.get('by', '?')}" + (f": {d['note']}" if d.get("note") else "")
    if e["kind"] == "start":
        return f"agent started ({d.get('agent')})"
    return json.dumps(d, sort_keys=True)


def report(lb: Logbook, lines: list[str], since: str | None = None) -> str:
    """A readable export for an authority or an auditor. The raw chain (--format jsonl) is the verifiable copy."""
    v, cfg = verify_lines(lines), lb.config
    rows = [json.loads(line.partition("\t")[2]) for line in lines]
    rows = [e for e in rows if not since or e["at"] >= since]
    chain = f"verified, {v['entries']} entries, head {v['head'][:16]}" if v["ok"] else f"BROKEN: {v['problem']}"
    out = [f"Ossilic logbook of robot {cfg['robot']}" + (f" at site {cfg['site']}" if cfg.get("site") else ""),
           f"Exported {utcnow()} by {AGENT}", f"Chain: {chain}", "",
           f"{'seq':>6}  {'time (UTC)':<24}  {'kind':<12}  details"]
    out += [f"{e['seq']:>6}  {e['at']:<24}  {e['kind']:<12}  {_detail(e)}" for e in rows]
    return "\n".join(out) + "\n"


def status(lb: Logbook) -> str:
    cfg, st, v, now = lb.config, lb.state(), lb.verify(), lb.identify()
    out = [f"Robot {cfg['robot']}" + (f" at site {cfg['site']}" if cfg.get("site") else "") + f", logbook {lb.home}",
           f"Chain: {v['entries']} entries, " + ("verified" if v["ok"] else f"BROKEN: {v['problem']}") + f", head {v['head'][:16]}",
           f"Hub: {cfg['hub']}, synced up to entry {st.get('synced', 0)}" if cfg.get("hub") else "Hub: not configured"]
    for name, c in now.items():
        rec = st["components"].get(name, {})
        state = "matches the record" if rec.get("tree") == c["tree"] else "CHANGED since the record"
        want = st.get("assigned", {}).get(name)
        out.append(f"  {name:<16} {rec.get('version') or '?':<12} tree {c['tree'][:8]}  {c['files']:>5} files  {state}"
                   + (f"; the Hub assigns {want}" if want and want != rec.get("version") else ""))
    return "\n".join(out)


def watch(lb: Logbook, interval: float, grace: float, sync_every: float) -> None:
    lb.append("start", agent=AGENT)
    last = float("-inf")
    while True:
        for e in lb.check(grace):
            print(f"{e['at']} undeclared change recorded: {e['data']['component']}", file=sys.stderr, flush=True)
        if lb.config.get("hub") and time.monotonic() - last >= sync_every:
            last = time.monotonic()
            try:
                hub.sync(lb)
            except Exception as err:  # the logbook keeps recording offline; the next sync sends the rest
                print(f"{utcnow()} sync failed: {err}", file=sys.stderr, flush=True)
        time.sleep(interval)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="ossilic", description="The Ossilic logbook: what runs on this robot, every change and every intervention.")
    p.add_argument("--home", help="logbook directory (default: $OSSILIC_HOME, else ~/.ossilic)")
    sub = p.add_subparsers(dest="cmd", required=True, metavar="command")
    s = sub.add_parser("init", help="start the logbook, or record a configuration change")
    s.add_argument("--robot", required=True)
    s.add_argument("--site")
    s.add_argument("--component", action="append", default=[], metavar="NAME=PATH[,PATH]", help="software to identify, e.g. picker=/opt/picker")
    s.add_argument("--hub", help="Hub address, e.g. https://hub.example.com")
    s.add_argument("--token", help="the fleet token from the Hub")
    sub.add_parser("status", help="what runs now, against the record")
    s = sub.add_parser("install", help="record that VERSION of COMPONENT is now installed")
    s.add_argument("component")
    s.add_argument("version")
    s.add_argument("--source", help="where it came from, e.g. a CI run URL")
    s.add_argument("--by")
    s.add_argument("--note")
    s = sub.add_parser("intervention", help="record an emergency stop, takeover or manual override")
    s.add_argument("type", help="e.g. estop, teleop, manual")
    s.add_argument("--by")
    s.add_argument("--note")
    s = sub.add_parser("count", help="add to an outcome counter, e.g. `ossilic count tasks`")
    s.add_argument("name")
    s.add_argument("value", nargs="?", type=float, default=1.0)
    s = sub.add_parser("watch", help="identify the software continuously, record undeclared changes, sync")
    s.add_argument("--interval", type=float, default=10.0, help="seconds between checks (default 10)")
    s.add_argument("--grace", type=float, default=60.0, help="seconds a change may go unrecorded before it is logged (default 60)")
    s.add_argument("--sync-every", type=float, default=60.0, help="seconds between syncs (default 60)")
    sub.add_parser("sync", help="send new entries and counters to the Hub now")
    s = sub.add_parser("assigned", help="print the version the Hub assigns to this robot")
    s.add_argument("component")
    s = sub.add_parser("verify", help="check every hash and link in a logbook")
    s.add_argument("file", nargs="?", help="an exported .jsonl chain (default: this robot's)")
    s = sub.add_parser("export", help="export the logbook for an authority or an auditor")
    s.add_argument("--format", choices=("text", "jsonl"), default="text")
    s.add_argument("--since", help="ISO date, e.g. 2026-01-20 (text format only)")
    s.add_argument("--out", help="file to write (default: standard output)")
    sub.add_parser("ros", help="record interventions from ROS 2 topics (see config.json \"ros\")")
    a = p.parse_args(argv)
    lb = Logbook(a.home)
    try:
        if a.cmd == "init":
            e = lb.init(a.robot, a.site, _components(a.component), a.hub, a.token)
            print(f"{'Started' if e['kind'] == 'init' else 'Updated'} the logbook of {a.robot} in {lb.home}")
            print(status(lb))
        elif a.cmd == "status":
            print(status(lb))
        elif a.cmd == "install":
            e = lb.install(a.component, a.version, a.by, a.source, a.note)
            print(f"Recorded {a.component} {a.version} (entry {e['seq']}, tree {e['data']['tree'][:8]})")
        elif a.cmd == "intervention":
            print(f"Recorded {a.type} (entry {lb.intervention(a.type, a.by, a.note)['seq']})")
        elif a.cmd == "count":
            lb.count(a.name, a.value)
        elif a.cmd == "watch":
            watch(lb, a.interval, a.grace, a.sync_every)
        elif a.cmd == "sync":
            r = hub.sync(lb)
            print(f"Sent {r['sent']} entries; the Hub holds up to entry {r['head']['seq']}")
        elif a.cmd == "assigned":
            print(lb.assigned(a.component) or "")
        elif a.cmd == "verify":
            lines = Path(a.file).read_text(encoding="utf-8").splitlines() if a.file else lb.lines()
            v = verify_lines(lines)
            print(f"Verified: {v['entries']} entries, head {v['head']}" if v["ok"] else f"Broken: {v['problem']}; entries before it are intact: {v['entries']}")
            return 0 if v["ok"] else 1
        elif a.cmd == "export":
            lines = lb.lines()
            text = "\n".join(lines) + "\n" if a.format == "jsonl" else report(lb, lines, a.since)
            Path(a.out).write_text(text, encoding="utf-8") if a.out else sys.stdout.write(text)
        elif a.cmd == "ros":
            from .ros import main as ros_main
            ros_main(lb)
    except (RuntimeError, KeyError) as err:
        print(f"ossilic: {err.args[0] if err.args else err}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
