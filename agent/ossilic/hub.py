"""Send the logbook and outcome counters to the Hub; receive the versions the Hub assigns to this robot."""
from __future__ import annotations

import json
import urllib.error
import urllib.request

from .logbook import AGENT, Logbook

BATCH = 1000


def _post(cfg: dict, body: dict, timeout: float) -> dict:
    req = urllib.request.Request(f"{cfg['hub']}/api/fleet/sync", data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", "authorization": f"Bearer {cfg.get('token', '')}"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def sync(lb: Logbook, timeout: float = 15.0) -> dict:
    """Send every entry the Hub has not witnessed, then the counters. The Hub checks that each batch
    continues the chain it already holds, so a rewritten logbook is refused, never merged."""
    cfg = lb.config
    if not cfg.get("hub"):
        raise RuntimeError("no Hub configured: run `ossilic init --robot ... --hub URL --token TOKEN`")
    counters, sent, reply = lb.take_counters(), 0, {}
    try:
        while True:
            after = lb.state().get("synced", 0)
            lines = lb.lines(after=after, limit=BATCH)
            body = {"robot": cfg["robot"], "site": cfg.get("site"), "agent": AGENT, "lines": lines,
                    "counters": [{"hour": k.split("|", 1)[0], "versions": json.loads(k.split("|", 1)[1]), "name": n, "value": v}
                                 for k, b in counters.items() for n, v in b.items()]}
            try:
                reply = _post(cfg, body, timeout)
            except urllib.error.HTTPError as err:
                with err:
                    text = err.read().decode(errors="replace")
                if err.code != 409:
                    raise RuntimeError(f"the Hub refused the sync ({err.code}): {text}") from None
                refusal = json.loads(text)
                seq, held = refusal.get("head", {}).get("seq", 0), refusal.get("head", {}).get("hash")
                mine = lb.lines(after=seq - 1, limit=1) if seq else []
                if seq != after and (seq == 0 or (mine and mine[0].split("\t", 1)[0] == held)):
                    lb.mark_synced(seq, lb.state().get("assigned", {}))  # resume from what the Hub holds
                    continue
                raise RuntimeError(f"chain conflict: {refusal.get('error')} The Hub holds entry {seq} as {held}; "
                                   "if this logbook differs there, it was replaced or rewritten after the Hub saw it.") from None
            counters, sent = {}, sent + len(lines)
            lb.mark_synced(reply["head"]["seq"], reply.get("assigned", {}))
            if len(lines) < BATCH:
                return {"sent": sent, "head": reply["head"], "assigned": reply.get("assigned", {})}
    except Exception:
        if counters:
            lb.put_back_counters(counters)
        raise
