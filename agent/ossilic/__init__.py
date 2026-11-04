"""Ossilic on the robot: the logbook, outcome counters, and the versions the Hub assigns.

    import ossilic
    if ossilic.assigned("picker") != running: redeploy()   # follows rollouts and rollbacks
    ossilic.count("tasks"); ossilic.count("failures", 0)    # outcomes for live comparison
"""
from __future__ import annotations

from .logbook import AGENT, Logbook, verify_lines

__all__ = ["AGENT", "Logbook", "verify_lines", "count", "assigned", "intervention"]
_book: Logbook | None = None


def _lb() -> Logbook:
    global _book
    _book = _book or Logbook()
    return _book


def count(name: str, value: float = 1.0) -> None:
    """Add to an outcome counter for this robot, this hour and the versions running now."""
    _lb().count(name, value)


def assigned(component: str) -> str | None:
    """The version this robot should run: the Hub's assignment, else the version installed."""
    return _lb().assigned(component)


def intervention(kind: str, note: str | None = None) -> dict:
    """Record an emergency stop, a remote takeover or a manual override."""
    return _lb().intervention(kind, note=note)
