"""Writes the reply fixtures in src/cbor_fixtures/: the bytes dimos's own RPC server (ZenohRPC._execute_rpc, whose
payloads are dimos.protocol.encode.cbor since dimos#4821) replies with, for realistic return values of each
ManipulationModule RPC the controller calls. No zenoh: _execute_rpc answers a stand-in query.

- <method>.cbor: a reply. The values are the ones captured from a running xArm7 sim when the payloads were pickles
  (scripts/sim_captures/), loaded as today's dimos classes, plus a snapshot and groups with the dual OpenYAM's groups,
  joints and frames (*_dual), an accepted non-blocking execute and a scene with obstacles.
- error.cbor: the error reply to a pickled request (what a controller from before this format sends): an IndexError
  at `args[0]`, since CBOR reads a pickle's first byte (0x80) as an empty array.
- enums.json: the members of the enums these replies carry. CBOR sends an enum as its class and value; cbor.rs names
  it from a table that a test checks against this.

What the server's API makes of each is src/cbor_fixtures/<method>.json (cbor.rs's tests; UPDATE_CBOR_FIXTURES=1 there
rewrites them). Run with a dimos venv:
    <dimos>/.venv/bin/python server/scripts/make_cbor_fixtures.py
"""

import json
from pathlib import Path
import pickle
import re
from typing import Any

from dimos.control.tasks.trajectory_task.trajectory_task import (
    TrajectoryExecutionResult,
    TrajectoryExecutionStatus,
)
from dimos.manipulation.manipulation_spec import (
    CommandStatus,
    ExecutionResult,
    ExecutionStatus,
    ManipulationSnapshot,
    OperationStatus,
    PlanningGroupInfo,
    PlanningGroupState,
    PlanStatus,
)
from dimos.manipulation.planning.spec.enums import PlanningStatus
from dimos.msgs.geometry_msgs.PoseStamped import PoseStamped
from dimos.msgs.sensor_msgs.JointState import JointState
from dimos.msgs.trajectory_msgs.TrajectoryStatus import TrajectoryState
from dimos.protocol.encode.cbor import decode, encode
from dimos.protocol.rpc.zenohrpc import EXCEPTION_ENCODING, ZenohRPC

SERVER = Path(__file__).resolve().parent.parent
CAPTURES = SERVER / "scripts" / "sim_captures"
FIXTURES = SERVER / "src" / "cbor_fixtures"


class Query:
    """The parts of a zenoh.Query that ZenohRPC._execute_rpc uses."""

    class Payload(bytes):
        def to_bytes(self) -> bytes:
            return bytes(self)

    def __init__(self, payload: bytes) -> None:
        self.payload = Query.Payload(payload)
        self.attachment = None
        self.key_expr = "dimos/rpc/ManipulationModule/method"
        self.replies: list[tuple[str, bytes]] = []

    def reply(self, _key: str, payload: bytes) -> None:
        self.replies.append(("ok", payload))

    def reply_err(self, payload: bytes, encoding: Any) -> None:
        assert encoding == EXCEPTION_ENCODING
        self.replies.append(("err", payload))

    def drop(self) -> None:
        pass


def serve(method: str, reply: Any, request: bytes) -> tuple[str, bytes]:
    """The one reply dimos's RPC server sends to `request` when `method` returns `reply`."""
    query = Query(request)
    ZenohRPC._execute_rpc(None, lambda *args, **kwargs: reply, method, query)  # type: ignore[arg-type]
    [answer] = query.replies
    return answer


def captured(name: str) -> Any:
    return pickle.loads((CAPTURES / f"{name}.pkl").read_bytes())


def dual_arm() -> tuple[tuple[PlanningGroupInfo, ...], ManipulationSnapshot]:
    """Two arm groups named as the dual OpenYAM's, one with a tip pose, gripper and preset, one without."""
    left = [f"left_joint{i}" for i in range(1, 7)]
    right = [f"right_joint{i}" for i in range(1, 7)]
    ts = 1794546541.2834
    groups = (
        PlanningGroupInfo("left_manipulator", tuple(left), "dual_openyam_base", "left_grasp_frame", True),
        PlanningGroupInfo("right_manipulator", tuple(right), "dual_openyam_base", None, False),
    )
    state = ManipulationSnapshot(
        timestamp=ts + 0.0123,
        operation_status=OperationStatus.HAS_PLAN,
        error=None,
        has_pending_plan=True,
        execution_status=ExecutionStatus.IDLE,
        groups={
            "left_manipulator": PlanningGroupState(
                joints=JointState(ts=ts, name=left, position=[0.012, 1.0473, 0.5236, -0.0021, 0.0, 0.0007]),
                end_effector_pose=PoseStamped(
                    ts, "world", position=[0.4012, 0.2337, 0.3121], orientation=[0.7071068, 0.0, 0.7071068, 0.0]
                ),
                gripper_position=0.8513,
                joint_presets={"home": JointState(ts=ts, name=left, position=[0.0, 1.0473, 0.5236, 0.0, 0.0, 0.0])},
            ),
            "right_manipulator": PlanningGroupState(
                joints=JointState(ts=ts, name=right, position=[-0.0102, 1.0469, 0.5233, 0.0, -0.0012, 0.0]),
                end_effector_pose=None,
                gripper_position=None,
                joint_presets={},
            ),
        },
    )
    return groups, state


def replies() -> dict[str, Any]:
    """Each fixture's return value."""
    groups, state = dual_arm()
    return {
        "get_state": captured("get_state"),
        "get_state_dual": state,
        "list_planning_groups": captured("list_planning_groups"),
        "list_planning_groups_dual": groups,
        "plan_to_joints": captured("plan_to_joints"),
        "plan_to_poses": captured("plan_to_poses"),
        "execute": captured("execute"),
        # execute(blocking=False) with a plan pending, as the controller calls it
        "execute_accepted": ExecutionResult(
            ExecutionStatus.ACCEPTED, "", coordinator_result=TrajectoryExecutionResult(TrajectoryExecutionStatus.ACCEPTED)
        ),
        "cancel": captured("cancel"),
        "clear_planned_path": captured("clear_planned_path"),
        "get_obstacles": captured("get_obstacles"),
        "get_obstacles_scene": {
            "table": PoseStamped(1794546541.5, "world", position=[0.55, 0.0, -0.02], orientation=[0.0, 0.0, 0.0, 1.0]),
            "mug": PoseStamped(
                1794546541.5, "world", position=[0.43, -0.12, 0.05], orientation=[0.0, 0.0, 0.3826834, 0.9238795]
            ),
        },
    }


def main() -> None:
    FIXTURES.mkdir(exist_ok=True)
    values = replies()
    # what dimos's own RPC client sends for a call without arguments
    no_arguments = encode(((), {}))
    for name, reply in values.items():
        kind, payload = serve(name, reply, no_arguments)
        assert kind == "ok" and payload == encode(reply), name
        (FIXTURES / f"{name}.cbor").write_bytes(payload)

    kind, payload = serve("get_state", None, pickle.dumps(([], {}), protocol=4))
    assert kind == "err"
    error = decode(payload)
    assert error["type_name"] == "IndexError", error
    # the traceback's file paths are this machine's
    error["traceback"] = re.sub(r'File "[^"]*/(dimos/[^"]+)"', r'File "\1"', error["traceback"])
    (FIXTURES / "error.cbor").write_bytes(encode(error))

    enums = [
        OperationStatus,
        PlanStatus,
        ExecutionStatus,
        CommandStatus,
        PlanningStatus,
        TrajectoryState,
        TrajectoryExecutionStatus,
    ]
    members = {cls.__name__: {member.name: member.value for member in cls} for cls in enums}
    (FIXTURES / "enums.json").write_text(json.dumps(members, indent=4) + "\n")
    print(f"wrote {len(values)} replies, error.cbor and enums.json to {FIXTURES}")


if __name__ == "__main__":
    main()
