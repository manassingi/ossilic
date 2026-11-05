import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from ossilic import hub
from ossilic.cli import main, report
from ossilic.logbook import GENESIS, Logbook, verify_lines


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.sw = self.dir / "picker"
        self.sw.mkdir()
        (self.sw / "policy.bin").write_bytes(b"v1 weights")
        self.lb = Logbook(self.dir / "home")
        self.lb.init("R-17", "site-b", {"picker": [str(self.sw)]})


class LogbookTest(Base):
    def test_records_chain_and_state(self):
        self.lb.install("picker", "2.3.0", by="ci")
        self.lb.intervention("estop", note="aisle blocked")
        v = self.lb.verify()
        self.assertTrue(v["ok"])
        self.assertEqual(v["entries"], 3)
        self.assertEqual(self.lb.state()["components"]["picker"]["version"], "2.3.0")
        self.assertEqual([e["kind"] for e in self.lb.entries()], ["init", "install", "intervention"])
        self.assertEqual(next(self.lb.entries())["prev"], GENESIS)

    def test_state_rebuilds_from_the_chain(self):
        self.lb.install("picker", "2.3.0")
        cached = self.lb.state()
        (self.lb.home / "state.json").unlink()
        rebuilt = self.lb.state()
        self.assertEqual({k: rebuilt[k] for k in ("seq", "head", "components")}, {k: cached[k] for k in ("seq", "head", "components")})

    def test_any_edit_removal_or_reorder_breaks_the_chain(self):
        for i in range(3):
            self.lb.intervention("teleop", note=str(i))
        lines = self.lb.lines()
        edited = lines[:2] + [lines[2].replace('"note":"1"', '"note":"x"')] + lines[3:]
        self.assertIn("entry 3 was altered", verify_lines(edited)["problem"])
        self.assertIn("entry 3 does not follow", verify_lines(lines[:2] + lines[3:])["problem"])
        self.assertIn("entry 2 does not follow", verify_lines([lines[0], lines[2], lines[1], lines[3]])["problem"])
        self.assertEqual(verify_lines(lines[:2])["entries"], 2, "a prefix is valid; the Hub's witnessed head catches truncation")

    def test_undeclared_changes_are_recorded_once(self):
        self.lb.install("picker", "2.3.0")
        (self.sw / "policy.bin").write_bytes(b"tampered weights")
        [change] = self.lb.check(grace=0)
        self.assertEqual(change["data"]["declared"], False)
        self.assertEqual(self.lb.check(grace=0), [])
        self.assertIsNone(self.lb.state()["components"]["picker"]["version"], "an undeclared change has no known version")

    def test_a_recorded_install_is_never_flagged(self):
        t = [0.0]
        (self.sw / "policy.bin").write_bytes(b"v2 weights")
        self.assertEqual(self.lb.check(grace=60, clock=lambda: t[0]), [], "inside the grace period")
        self.lb.install("picker", "2.4.0")
        t[0] = 120
        self.assertEqual(self.lb.check(grace=60, clock=lambda: t[0]), [])

    def test_counters_are_keyed_by_hour_and_versions(self):
        self.lb.install("picker", "2.3.0")
        self.lb.count("tasks")
        self.lb.count("tasks")
        self.lb.count("failures", 0)
        batch = self.lb.pending_counters()
        [(key, bucket)] = batch["buckets"].items()
        self.assertEqual(json.loads(key.split("|", 1)[1]), {"picker": "2.3.0"})
        self.assertEqual(bucket, {"tasks": 2, "failures": 0})
        self.lb.count("tasks")
        self.assertEqual(self.lb.pending_counters(), batch, "a pending batch stays unchanged until the Hub confirms it")
        self.lb.clear_pending(batch["id"])
        self.assertEqual(self.lb.pending_counters()["buckets"][key], {"tasks": 1}, "counts made meanwhile go in the next batch")

    def test_export_and_cli(self):
        self.lb.install("picker", "2.3.0", by="ci", source="https://ci/run/1")
        text = report(self.lb, self.lb.lines())
        self.assertIn("Chain: verified, 2 entries", text)
        self.assertIn("picker ? -> 2.3.0", text)
        out = self.dir / "chain.jsonl"
        home = str(self.lb.home)
        self.assertEqual(main(["--home", home, "export", "--format", "jsonl", "--out", str(out)]), 0)
        self.assertEqual(main(["--home", home, "verify", str(out)]), 0)
        out.write_text(out.read_text().replace("2.3.0", "9.9.9"))
        self.assertEqual(main(["--home", home, "verify", str(out)]), 1)
        self.assertEqual(main(["--home", home, "install", "nope", "1"]), 1)

    def test_one_logbook_per_robot(self):
        with self.assertRaises(RuntimeError):
            self.lb.init("R-99")
        self.assertEqual(self.lb.init("R-17", components={"mapper": [str(self.sw)]})["kind"], "config")


class FakeHub(BaseHTTPRequestHandler):
    """Accepts batches that continue its chain; answers 409 with its head otherwise."""
    head = {"seq": 0, "hash": GENESIS}
    counters: list = []
    batches: set = set()
    drop_reply = False

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        lines = body["lines"]
        first = json.loads(lines[0].split("\t", 1)[1]) if lines else None
        if first and (first["seq"] != self.head["seq"] + 1 or first["prev"] != self.head["hash"]):
            return self._send(409, {"error": "does not continue the chain.", "head": self.head})
        if lines:
            FakeHub.head = {"seq": first["seq"] + len(lines) - 1, "hash": lines[-1].split("\t", 1)[0]}
        if body["batch"] not in FakeHub.batches:
            FakeHub.batches.add(body["batch"])
            FakeHub.counters += body["counters"]
        if FakeHub.drop_reply:  # the Hub stored everything, but the reply never arrives
            FakeHub.drop_reply = False
            raise ConnectionResetError("reply lost")
        self._send(200, {"head": self.head, "assigned": {"picker": "2.3.0"}})

    def _send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


class SyncTest(Base):
    def setUp(self):
        super().setUp()
        FakeHub.head, FakeHub.counters, FakeHub.batches, FakeHub.drop_reply = {"seq": 0, "hash": GENESIS}, [], set(), False
        self.server = HTTPServer(("127.0.0.1", 0), FakeHub)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.lb.init("R-17", hub=f"http://127.0.0.1:{self.server.server_port}", token="flt_test")

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_sync_sends_the_chain_and_counters_and_stores_the_assignment(self):
        self.lb.count("tasks", 3)
        r = hub.sync(self.lb)
        self.assertEqual(r["sent"], 2)
        self.assertEqual(FakeHub.head["seq"], 2)
        self.assertEqual(FakeHub.counters[0]["value"], 3)
        self.assertEqual(self.lb.assigned("picker"), "2.3.0")
        self.assertEqual(hub.sync(self.lb)["sent"], 0)

    def test_resumes_when_the_marker_is_behind(self):
        hub.sync(self.lb)
        self.lb.intervention("estop")
        st = self.lb.state()
        st["synced"] = 0
        (self.lb.home / "state.json").write_text(json.dumps(st))
        self.assertEqual(hub.sync(self.lb)["head"]["seq"], 3)

    def test_a_rewritten_logbook_is_refused_and_counters_are_kept(self):
        hub.sync(self.lb)
        (self.lb.home / "logbook.jsonl").unlink()
        (self.lb.home / "state.json").unlink()
        self.lb.init("R-17")
        self.lb.count("tasks")
        with self.assertRaisesRegex(RuntimeError, "chain conflict"):
            hub.sync(self.lb)
        self.assertEqual(sum(b["tasks"] for b in self.lb.pending_counters()["buckets"].values()), 1)

    def test_a_lost_reply_is_retried_without_counting_twice(self):
        self.lb.count("tasks", 5)
        FakeHub.drop_reply = True
        with self.assertRaises(Exception):
            hub.sync(self.lb)
        self.lb.count("tasks", 2)
        hub.sync(self.lb)
        hub.sync(self.lb)
        self.assertEqual(sum(c["value"] for c in FakeHub.counters), 7, "the resent batch kept its id, so the Hub took it once")


if __name__ == "__main__":
    unittest.main()
