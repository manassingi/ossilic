# Ossilic agent

The logbook on the robot: a tamper-evident record of what software runs on it, every change to that software, and every intervention. No dependencies beyond Python 3.9 on Linux or macOS.

```bash
pip install "git+https://github.com/manassingi/ossilic#subdirectory=agent"
ossilic init --robot R-17 --site site-b --component picker=/opt/picker --hub https://hub.example.com --token flt_...
ossilic install picker 2.3.0       # run after every deploy
ossilic watch                      # identifies the software continuously and syncs to the Hub
```

`init` and `install` take seconds. Without `--hub` the logbook works fully offline.

## What it records

| Entry | When |
|---|---|
| `init`, `config` | The logbook starts, or the declared components change. Each component's identity: one SHA-256 over its files. |
| `install` | Your deploy says a version is installed: the version, the files' hash, who, and where it came from (a CI run is detected automatically). |
| `change` | The files of a component changed and no install was recorded within the grace period (60 s by default): evidence of an undeclared modification. |
| `intervention` | An emergency stop, a remote takeover, a manual override: `ossilic intervention estop --note "aisle blocked"`, or from ROS 2 topics. |
| `start` | The agent started (the robot booted). |

These are the on-machine records that EU Machinery Regulation 2023/1230 asks for from 20 January 2027 (Annex III 1.1.9: identify the safety software at all times and collect evidence of interventions; 1.2.1(f): a log of uploaded safety-software versions kept for five years). The logbook supports that evidence; it does not make a machine compliant on its own.

## Why it is tamper-evident

`~/.ossilic/logbook.jsonl` (or `$OSSILIC_HOME`) has one line per entry: `<sha256 of the entry>\t<entry JSON>`. Every entry carries the hash of the one before it, so editing, removing or reordering any entry breaks the chain from there. `ossilic verify` checks every link. Syncing gives the Hub a witnessed copy: it accepts only entries that continue the chain it holds, so replacing a robot's whole logbook is detected too.

## Commands

| Command | Does |
|---|---|
| `ossilic status` | What runs now, against the record |
| `ossilic install COMPONENT VERSION [--source URL] [--note]` | Record an install |
| `ossilic intervention TYPE [--note]` | Record an intervention |
| `ossilic count NAME [VALUE]` | Add to an outcome counter (tasks, failures, interventions, hours) |
| `ossilic watch [--interval 10] [--grace 60] [--sync-every 60]` | Identify continuously, record undeclared changes, sync |
| `ossilic sync` | Send new entries and counters now |
| `ossilic assigned COMPONENT` | The version the Hub wants here (a rollout or a rollback) |
| `ossilic verify [FILE]` | Check every hash and link |
| `ossilic export [--format text\|jsonl] [--since DATE] [--out FILE]` | A readable report, or the raw chain, for an authority or an auditor |
| `ossilic ros` | Record interventions from ROS 2 Bool topics |

## From your robot's code

```python
import ossilic

ossilic.count("tasks")                       # outcomes, per hour and per running version
ossilic.count("failures", 0 if ok else 1)
ossilic.count("hours", dt / 3600)
if ossilic.assigned("picker") != running:    # follow rollouts and rollbacks
    redeploy(ossilic.assigned("picker"))     # then: ossilic install picker <version>
```

Counters drive live rollouts on the Hub: a new version runs on a few robots per site, their rates are compared with the rest of the fleet over the same hours, and the Hub promotes the version or rolls it back.

## Run it as a service

Copy `systemd/ossilic.service` to `/etc/systemd/system/`, then `systemctl enable --now ossilic`. It keeps the logbook in `/var/lib/ossilic`; run `init` and `install` with `OSSILIC_HOME=/var/lib/ossilic`.

## ROS 2

Add the topics to `config.json` and run `ossilic ros` in a sourced ROS 2 shell. Each topic logs one entry when it turns true:

```json
"ros": { "estop": "/emergency_stop", "teleop": "/teleop/active" }
```
