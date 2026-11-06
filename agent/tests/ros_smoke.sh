#!/usr/bin/env bash
# In a ROS 2 environment: `ossilic ros` turns a std_msgs/Bool topic going true into exactly one intervention entry.
set -eo pipefail
source /opt/ros/*/setup.bash
set -u
export PYTHONPATH="$(cd "$(dirname "$0")/.." && pwd):${PYTHONPATH:-}" OSSILIC_HOME="$(mktemp -d)"  # keep ROS 2's own Python path
python3 -m ossilic.cli init --robot ros-test > /dev/null
python3 -c 'import json, os, pathlib; p = pathlib.Path(os.environ["OSSILIC_HOME"], "config.json"); c = json.loads(p.read_text()); c["ros"] = {"estop": "/emergency_stop"}; p.write_text(json.dumps(c))'
python3 -m ossilic.cli ros & bridge=$!
sleep 3
ros2 topic pub -w 1 --times 3 --rate 2 /emergency_stop std_msgs/msg/Bool "{data: true}" > /dev/null
sleep 2
kill "$bridge" 2> /dev/null || true
n=$(python3 -m ossilic.cli export --format jsonl | grep -c '"kind":"intervention"' || true)
python3 -m ossilic.cli verify
[ "$n" = "1" ] && echo "ROS 2: one activation, one intervention entry" || { echo "expected 1 intervention entry, found $n"; exit 1; }
