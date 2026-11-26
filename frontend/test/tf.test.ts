import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1"
import { Vector3 } from "three"
import { TfGraph } from "../src/core/tf.ts"
import { isTreeTopic } from "../src/core/tfFeed.ts"

const yaw90: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2]
const none: [number, number, number, number] = [0, 0, 0, 1]
const placed = (tree: TfGraph, frame: string, fixed: string, point = new Vector3()) => point.applyMatrix4(tree.lookup(frame, fixed)!)

Deno.test("a chain composes parent to child, and works from the other end too", () => {
    const tree = new TfGraph()
    tree.set("world", "odom", [1, 0, 0], none, true)
    tree.set("odom", "base_link", [0, 2, 0], yaw90, false)
    tree.set("base_link", "lidar", [1, 0, 0.5], none, true)
    // lidar's origin: base is at (1,2,0) facing +y, so 1 m forward is +y
    const lidar = placed(tree, "lidar", "world")
    assertAlmostEquals(lidar.x, 1)
    assertAlmostEquals(lidar.y, 3)
    assertAlmostEquals(lidar.z, 0.5)
    // and the world origin seen from the lidar frame
    const origin = placed(tree, "world", "lidar")
    assertAlmostEquals(origin.length(), Math.hypot(1, 3, 0.5))
    assertEquals(tree.lookup("", "world")?.equals(tree.lookup("world", "world")!), true)
})

Deno.test("frames in different trees, or unknown ones, have no placement", () => {
    const tree = new TfGraph()
    tree.set("world", "base_link", [0, 0, 0], none, false)
    tree.set("camera_root", "camera", [0, 0, 0], none, false)
    assertEquals(tree.lookup("camera", "world"), null)
    assertEquals(tree.lookup("nope", "world"), null)
    const problems = tree.snapshot().problems
    assertEquals(problems.roots, ["camera_root", "world"])
})

Deno.test("problems: staleness (tf_static exempt, also once it comes again on tf)", async () => {
    const tree = new TfGraph()
    tree.set("map", "base_link", [0, 0, 0], none, false)
    tree.set("map", "static_thing", [0, 0, 0], none, true)
    // a HardwareModule republishes its tf_static edges on tf: once seen on tf_static, an edge stays static (valid at all times)
    tree.set("map", "static_thing", [0, 0, 0], none, false)
    assertEquals(tree.snapshot().problems.stale, [])
    await new Promise((resolve) => setTimeout(resolve, 2100))
    assertEquals(tree.snapshot().problems.stale, ["base_link"])
})

Deno.test("the default fixed frame prefers world-ish roots", () => {
    const tree = new TfGraph()
    tree.set("map", "odom", [0, 0, 0], none, true)
    tree.set("odom", "base_link", [0, 0, 0], none, false)
    assertEquals(tree.defaultFixedFrame(), "map")
    const empty = new TfGraph()
    assertEquals(empty.defaultFixedFrame(), "world")
    // no tf at all: world and map stand in for each other
    assert(empty.lookup("map", "world"))
})

Deno.test("the tf tree is fed by topics named tf or tf_static only, not side channels like a planner's manipulation_tf", () => {
    for (const name of ["/tf", "tf", "/tf_static", "/robot/tf", "/robot/tf_static"]) {
        assert(isTreeTopic(name), name)
    }
    for (const name of ["/manipulation_tf", "/tf_debug", "/odom", "/robot/manipulation_tf"]) {
        assert(!isTreeTopic(name), name)
    }
})

// ---- the graph: several parents, one path, hardware vs imaginary by the USDs, two roots ----

/** a dog in a sim: the world estimate (world → odom → go2/base_link) and the dog's own USD (go2 → go2/base_link → go2/head → lidar on it) */
function dog() {
    const tree = new TfGraph()
    tree.set("world", "odom", [0, 0, 0], none, true)
    tree.set("odom", "go2/base_link", [2, 0, 0], yaw90, false)
    tree.set("go2", "go2/base_link", [0, 0, 0.3], none, true)
    tree.set("go2/base_link", "go2/head", [0.3, 0, 0], none, true)
    tree.set("go2/head", "go2/head/lidar", [0, 0, 0.1], none, true)
    tree.setHardware("go2", ["go2", "go2/base_link", "go2/head"])
    tree.setHardware("go2/head/lidar", ["go2/head/lidar"])
    return tree
}

Deno.test("a frame with two parents (its USD's and an estimate) is placed through both, and frames on either side meet through it", () => {
    const tree = dog()
    const head = placed(tree, "go2/head", "world")
    // base at (2,0,0) facing +y, head 0.3 m ahead of it
    assertAlmostEquals(head.x, 2)
    assertAlmostEquals(head.y, 0.3)
    // the USD's root ("go2") is under the base, against its published direction
    const top = placed(tree, "go2", "world")
    assertAlmostEquals(top.x, 2)
    assertAlmostEquals(top.z, -0.3)
    // and the world from the lidar
    assert(tree.lookup("world", "go2/head/lidar"))
    assertEquals(tree.snapshot().problems.cycle, [])
})

Deno.test("hardware is an edge between two prims of provided USDs, whatever the frames are called; the rest are estimates", () => {
    const tree = dog()
    assertEquals(tree.kindOf("go2", "go2/base_link"), "hardware")
    assertEquals(tree.kindOf("go2/head", "go2/head/lidar"), "hardware", "a mount: both ends are prims, of two modules")
    assertEquals(tree.kindOf("odom", "go2/base_link"), "imaginary")
    assertEquals(tree.kindOf("world", "odom"), "imaginary")
    // no naming rule: a frame called like hardware is an estimate until a USD names it
    tree.set("go2/base_link", "go2/base_link_estimate", [0, 0, 0], none, false)
    assertEquals(tree.kindOf("go2/base_link", "go2/base_link_estimate"), "imaginary")
    tree.setHardware("go2/head/lidar", null)
    assertEquals(tree.kindOf("go2/head", "go2/head/lidar"), "imaginary")
})

Deno.test("the nav root and the hardware root: one toggle re-roots the tree, its parents and the default fixed frame", () => {
    const tree = dog()
    assertEquals(tree.root, "nav")
    assertEquals(tree.defaultFixedFrame(), "world")
    assertEquals(tree.parentOf("go2/base_link"), "odom")
    assertEquals(tree.parentOf("go2"), "go2/base_link")
    assertEquals(tree.snapshot().problems.roots, ["world"])
    const flipped = tree.snapshot().edges.find((edge) => edge.child === "go2")!
    assertEquals([flipped.parent, flipped.flipped, flipped.kind], ["go2/base_link", true, "hardware"])
    tree.root = "hardware"
    assertEquals(tree.hardwareRoot(), "go2")
    assertEquals(tree.defaultFixedFrame(), "go2")
    assertEquals(tree.parentOf("go2/base_link"), "go2")
    assertEquals(tree.parentOf("odom"), "go2/base_link")
    assertEquals(tree.parentOf("world"), "odom")
    assertEquals(tree.snapshot().problems.roots, ["go2"])
    // the world seen from the dog's hardware root: its base is 0.3 m over it, and odom has the base at (2,0,0) turned 90°
    const world = placed(tree, "world", "go2")
    assertAlmostEquals(world.z, 0.3)
    assertAlmostEquals(Math.hypot(world.x, world.y), 2)
    // with no USD loaded there is no hardware root: the nav root stands in
    const bare = new TfGraph()
    bare.set("map", "base_link", [0, 0, 0], none, false)
    bare.root = "hardware"
    assertEquals(bare.defaultFixedFrame(), "map")
})

Deno.test("a second path between two frames is reported, and the tree takes the shorter (hardware and static first)", () => {
    const tree = dog()
    tree.set("world", "go2", [5, 5, 0], none, false)
    const snapshot = tree.snapshot()
    assertEquals(snapshot.offTree.length, 1)
    assert(snapshot.problems.cycle.length > 0)
    assertEquals(tree.parentOf("go2"), "world")
})

Deno.test("lookupAt follows the graph and interpolates each edge, walked either way", () => {
    const tree = new TfGraph()
    tree.set("odom", "base", [0, 0, 0], none, false, 1000)
    tree.set("odom", "base", [2, 0, 0], none, false, 1100)
    tree.set("robot", "base", [0, 0, 0], none, true)
    const halfway = new Vector3().applyMatrix4(tree.lookupAt("robot", "odom", 1050)!)
    assertAlmostEquals(halfway.x, 1)
    const back = new Vector3().applyMatrix4(tree.lookupAt("odom", "robot", 1100)!)
    assertAlmostEquals(back.x, -2)
})
