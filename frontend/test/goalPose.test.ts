// The goal the 3D view's "Go here, facing…" sends, and the cancel its "Cancel goal" sends.
import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1"
import { decode } from "../src/core/lcm/lcm.ts"
import { cancelGoal, goalPose } from "../src/core/goalPose.ts"

Deno.test("a goal with a yaw is a PoseStamped on dimos/goal, its quaternion a turn about +z", () => {
    const { key, bytes } = goalPose({ x: 1.5, y: -2, z: 0.1 }, Math.PI / 2, "map", 1_700_000_123_456)
    assertEquals(key, "dimos/goal/geometry_msgs.PoseStamped")
    const message = decode("geometry_msgs.PoseStamped", bytes)
    assertEquals(message.header.frame_id, "map")
    assertEquals(message.header.stamp, { sec: 1_700_000_123, nsec: 456_000_000 })
    assertEquals(message.pose.position, { x: 1.5, y: -2, z: 0.1 })
    const { x, y, z, w } = message.pose.orientation
    assertEquals([x, y], [0, 0])
    assertAlmostEquals(z, Math.SQRT1_2)
    assertAlmostEquals(w, Math.SQRT1_2)
})

Deno.test("a cancel is a NaN goal as both a PointStamped and a PoseStamped with no heading", () => {
    const [point, pose] = cancelGoal("map")
    assertEquals(point.key, "dimos/goal/geometry_msgs.PointStamped")
    assertEquals(pose.key, "dimos/goal/geometry_msgs.PoseStamped")
    const pointMessage = decode("geometry_msgs.PointStamped", point.bytes)
    assertEquals(Object.values(pointMessage.point).every(Number.isNaN), true)
    const poseMessage = decode("geometry_msgs.PoseStamped", pose.bytes)
    assertEquals(Object.values(poseMessage.pose.position).every(Number.isNaN), true)
    assertEquals(poseMessage.pose.orientation, { x: 0, y: 0, z: 0, w: 0 })
    assertEquals(poseMessage.header.frame_id, "map")
})
