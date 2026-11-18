// The 3D view menu's "Go here, facing…" and "Cancel goal": a geometry_msgs.PoseStamped on /goal (a position and the yaw to
// face there; dimos's PoseStamped goals) and the NaN goal that cancels the one under way, sent as both a PointStamped
// (dimos main's /goal) and a PoseStamped (its all-zero quaternion = no heading), so either nav stack stops.
import { encode } from "./lcm/lcm.ts"
import { dimosKey } from "./transport.ts"
import { POINT_STAMPED } from "./clickedPoint.ts"

export const GOAL_TOPIC = "/goal"
export const POSE_STAMPED = "geometry_msgs.PoseStamped"

const stampOf = (nowMs: number) => ({ sec: Math.floor(nowMs / 1000), nsec: (nowMs % 1000) * 1_000_000 })

/** The zenoh key and LCM bytes for a goal at `point` facing `yaw` (radians about +z) in `frameId`, stamped `nowMs`. */
export function goalPose(point: { x: number; y: number; z: number }, yaw: number, frameId: string, nowMs = Date.now()): { key: string; bytes: Uint8Array } {
    const orientation = { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) }
    const bytes = encode(POSE_STAMPED, { header: { stamp: stampOf(nowMs), frame_id: frameId }, pose: { position: { x: point.x, y: point.y, z: point.z }, orientation } })
    return { key: dimosKey(GOAL_TOPIC, POSE_STAMPED), bytes }
}

/** The goals that cancel the one under way, in `frameId`: one per goal type a nav stack may read on /goal. */
export function cancelGoal(frameId: string, nowMs = Date.now()): { key: string; bytes: Uint8Array }[] {
    const header = { stamp: stampOf(nowMs), frame_id: frameId }
    const nowhere = { x: NaN, y: NaN, z: NaN }
    return [
        { key: dimosKey(GOAL_TOPIC, POINT_STAMPED), bytes: encode(POINT_STAMPED, { header, point: nowhere }) },
        { key: dimosKey(GOAL_TOPIC, POSE_STAMPED), bytes: encode(POSE_STAMPED, { header, pose: { position: nowhere, orientation: { x: 0, y: 0, z: 0, w: 0 } } }) },
    ]
}
