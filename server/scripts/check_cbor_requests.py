"""dimos's own RPC server on the requests server/src/cbor.rs writes (src/cbor_fixtures/ours_*.req.cbor): each must be
byte for byte what dimos's own RPC client sends for the call, and ZenohRPC._execute_rpc (answering a stand-in query,
no zenoh) must decode it into the intended (args, kwargs), as dimos's classes, that ManipulationModule's method takes.
Run with a dimos venv:
    <dimos>/.venv/bin/python server/scripts/check_cbor_requests.py
"""

import inspect
from typing import Any

from make_cbor_fixtures import FIXTURES, Query

from dimos.manipulation.manipulation_module import ManipulationModule
from dimos.msgs.geometry_msgs.PoseStamped import PoseStamped
from dimos.msgs.sensor_msgs.JointState import JointState
from dimos.protocol.encode.cbor import encode
from dimos.protocol.rpc.zenohrpc import ZenohRPC

TS = 1791963651.7957
JOINTS = [f"joint{i}" for i in range(1, 8)]
# the tool pointing down
DOWN = [0.0, 1.0, 0.0, 0.0]

# request -> the methods it is sent to, args, kwargs (what manipulation.rs means by it)
CALLS: dict[str, tuple[list[str], tuple[Any, ...], dict[str, Any]]] = {
    "empty": (["get_state", "list_planning_groups", "cancel", "clear_planned_path", "get_obstacles"], (), {}),
    "execute": (["execute"], (), {"blocking": False, "plan_id": "84a9de8e36c04ece99efcd5d7716bf88"}),
    "plan_to_joints": (
        ["plan_to_joints"],
        ({"manipulator": JointState(ts=TS, name=JOINTS, position=[0.6, 0.1, 0.0, 1.2, 0.0, 1.0, 0.0])},),
        {"speed_scale": 0.5},
    ),
    "plan_to_poses": (
        ["plan_to_poses"],
        ({"manipulator": PoseStamped(TS, "world", position=[0.35, 0.2, 0.45], orientation=[1.0, 0.0, 0.0, 0.0])},),
        {},
    ),
    "plan_to_poses_dual": (
        ["plan_to_poses"],
        (
            {
                "left_manipulator": PoseStamped(1794546541.2834, "world", position=[0.4012, 0.2337, 0.3121], orientation=DOWN),
                "right_manipulator": PoseStamped(1794546541.2834, "world", position=[0.4012, -0.2337, 0.3121], orientation=DOWN),
            },
        ),
        {"speed_scale": 0.25},
    ),
}


def same(ours: Any, intended: Any) -> bool:
    """Equal values; a message by class and every field (JointState's own == leaves out ts, PoseStamped's frame)."""
    if isinstance(intended, JointState):
        fields = ("ts", "frame_id", "name", "position", "velocity", "effort")
        return type(ours) is JointState and all(getattr(ours, f) == getattr(intended, f) for f in fields)
    if isinstance(intended, PoseStamped):
        axes = [(p, a) for p in ("position", "orientation") for a in "xyzw"[: 3 if p == "position" else 4]]
        return (
            type(ours) is PoseStamped
            and (ours.ts, ours.frame_id) == (intended.ts, intended.frame_id)
            and all(getattr(getattr(ours, p), a) == getattr(getattr(intended, p), a) for p, a in axes)
        )
    if isinstance(intended, dict):
        return type(ours) is dict and list(ours) == list(intended) and all(same(ours[k], intended[k]) for k in intended)
    if isinstance(intended, tuple):
        return type(ours) is tuple and len(ours) == len(intended) and all(map(same, ours, intended))
    return type(ours) is type(intended) and ours == intended


for name, (methods, args, kwargs) in CALLS.items():
    payload = (FIXTURES / f"ours_{name}.req.cbor").read_bytes()
    # ZenohRPC.call_cb sends encode(arguments), arguments being RpcCall's (args, kwargs)
    assert payload == encode((args, kwargs)), f"{name}: not the bytes dimos's client sends"
    for method in methods:
        received: list[tuple[tuple[Any, ...], dict[str, Any]]] = []

        def call(*call_args: Any, **call_kwargs: Any) -> None:
            inspect.signature(getattr(ManipulationModule, method)).bind(None, *call_args, **call_kwargs)
            received.append((call_args, call_kwargs))

        query = Query(payload)
        ZenohRPC._execute_rpc(None, call, method, query)  # type: ignore[arg-type]
        assert query.replies == [("ok", encode(None))], f"{name} -> {method}: {query.replies}"
        [(call_args, call_kwargs)] = received
        assert same(call_args, args) and same(call_kwargs, kwargs), f"{name} -> {method}: {received}"

print("ok: dimos's RPC server reads every request the controller writes, as dimos's own client would send it")
