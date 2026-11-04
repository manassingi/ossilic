"""Record interventions from ROS 2: each configured std_msgs/Bool topic logs one entry when it turns true.

In config.json:  "ros": {"estop": "/emergency_stop", "teleop": "/teleop/active"}
"""
from __future__ import annotations

from .logbook import Logbook


def main(lb: Logbook) -> None:
    topics = lb.config.get("ros", {})
    if not topics:
        raise RuntimeError('no topics to watch: add "ros": {"estop": "/emergency_stop"} to config.json')
    try:
        import rclpy
        from std_msgs.msg import Bool
    except ImportError:
        raise RuntimeError("ROS 2 is not available here: source your ROS 2 setup, then run `ossilic ros` again") from None
    rclpy.init()
    node, active = rclpy.create_node("ossilic_logbook"), {}

    def on(kind: str):
        def heard(msg) -> None:
            if msg.data and not active.get(kind):  # one entry per activation, not per message
                lb.intervention(kind, by="ros", note=f"{topics[kind]} became true")
            active[kind] = msg.data
        return heard

    for kind, topic in topics.items():
        node.create_subscription(Bool, topic, on(kind), 10)
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        rclpy.shutdown()
