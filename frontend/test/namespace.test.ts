// The robot namespace (core/namespace.ts): keys into it and back, the topics a page sees, the namespaces found, frames
// stripped on the way in and given back on the way out, and the client that maps every key.
import { assertEquals } from "jsr:@std/assert@1"
import { cleanNamespace, forgetFrames, fromWire, levelsOf, namespacedClient, namespacedTopics, prefixFrames, seenNamespaces, stripFrames, toWire } from "../src/core/namespace.ts"
import { parseKey, type Topic } from "../src/core/transport.ts"

const topic = (key: string) => parseKey(key) as Topic
const BUS = [
    topic("dimos/robot0/odom/nav_msgs.Odometry"),
    topic("dimos/robot0/cmd_vel/geometry_msgs.Twist"),
    topic("dimos/robot1/odom/nav_msgs.Odometry"),
    topic("dimos/global_map/sensor_msgs.PointCloud2"),
    topic("dimos/odom/nav_msgs.Odometry"),
    topic("dimos/file_info/std_msgs.String"),
    topic("dimos/file_info/go2/std_msgs.String"),
]

Deno.test("keys go into the namespace and back; Desktop's own keys and other prefixes don't", () => {
    forgetFrames()
    assertEquals(toWire("dimos/cmd_vel/geometry_msgs.Twist", "robot1"), "dimos/robot1/cmd_vel/geometry_msgs.Twist")
    assertEquals(toWire("dimos/events/launch", "robot1"), "dimos/events/launch")
    assertEquals(toWire("dim-controller/frontend/x", "robot1"), "dim-controller/frontend/x")
    assertEquals(toWire("dimos/cmd_vel/geometry_msgs.Twist", ""), "dimos/cmd_vel/geometry_msgs.Twist")
    assertEquals(fromWire("dimos/robot1/odom/nav_msgs.Odometry", "robot1"), "dimos/odom/nav_msgs.Odometry")
    assertEquals(fromWire("dimos/robot0/odom/nav_msgs.Odometry", "robot1"), "dimos/robot0/odom/nav_msgs.Odometry")
})

Deno.test("namespaces on the bus: a topic's first part, unless that part is a topic itself", () => {
    assertEquals(seenNamespaces(BUS), ["robot0", "robot1"])
})

Deno.test("nested namespaces: names, levels innermost first", () => {
    assertEquals([cleanNamespace("fleet/robot1"), cleanNamespace("/fleet/"), cleanNamespace("a b"), cleanNamespace("a//b")], ["fleet/robot1", "fleet", "", ""])
    assertEquals(levelsOf("fleet/robot1"), ["fleet/robot1", "fleet", ""])
    assertEquals(levelsOf(""), [""])
})

const NESTED = [
    topic("dimos/fleet/robot0/odom/nav_msgs.Odometry"),
    topic("dimos/fleet/robot0/cmd_vel/geometry_msgs.Twist"),
    topic("dimos/fleet/robot1/odom/nav_msgs.Odometry"),
    topic("dimos/fleet/robot1/tf/tf2_msgs.TFMessage"),
    topic("dimos/fleet/map/nav_msgs.OccupancyGrid"),
    topic("dimos/fleet/odom/nav_msgs.Odometry"),
    topic("dimos/global_map/sensor_msgs.PointCloud2"),
]

Deno.test("nested: the robot's own topics, then its fleet's shared ones, then the global ones; inner names win, keys route back", () => {
    assertEquals(seenNamespaces(NESTED), ["fleet", "fleet/robot0", "fleet/robot1"])
    const seen = namespacedTopics(NESTED, "fleet/robot1")
    assertEquals(seen.map((one) => one.key), [
        "dimos/odom/nav_msgs.Odometry",
        "dimos/tf/tf2_msgs.TFMessage",
        "dimos/map/nav_msgs.OccupancyGrid",
        "dimos/global_map/sensor_msgs.PointCloud2",
    ])
    assertEquals(toWire("dimos/odom/nav_msgs.Odometry", "fleet/robot1"), "dimos/fleet/robot1/odom/nav_msgs.Odometry")
    assertEquals(toWire("dimos/map/nav_msgs.OccupancyGrid", "fleet/robot1"), "dimos/fleet/map/nav_msgs.OccupancyGrid")
    assertEquals(toWire("dimos/global_map/sensor_msgs.PointCloud2", "fleet/robot1"), "dimos/global_map/sensor_msgs.PointCloud2")
    assertEquals(toWire("dimos/cmd_vel/geometry_msgs.Twist", "fleet/robot1"), "dimos/fleet/robot1/cmd_vel/geometry_msgs.Twist")
    assertEquals(fromWire("dimos/fleet/map/nav_msgs.OccupancyGrid", "fleet/robot1"), "dimos/map/nav_msgs.OccupancyGrid")
    // the fleet level: its own topics, not a robot's
    assertEquals(namespacedTopics(NESTED, "fleet").map((one) => one.key), ["dimos/map/nav_msgs.OccupancyGrid", "dimos/odom/nav_msgs.Odometry", "dimos/global_map/sensor_msgs.PointCloud2"])
    forgetFrames()
})

Deno.test("nested frames: the robot's and its fleet's lose their prefix, and get the same one back", () => {
    forgetFrames()
    const tf = { transforms: [{ header: { frame_id: "fleet/map" }, child_frame_id: "fleet/robot1/odom" }, { header: { frame_id: "fleet/robot1/odom" }, child_frame_id: "fleet/robot1/base_link" }] }
    stripFrames(tf, "fleet/robot1")
    assertEquals(tf.transforms.map((one) => [one.header.frame_id, one.child_frame_id]), [["map", "odom"], ["odom", "base_link"]])
    assertEquals([prefixFrames({ header: { frame_id: "map" } }, "fleet/robot1").header.frame_id, prefixFrames({ header: { frame_id: "odom" } }, "fleet/robot1").header.frame_id], ["fleet/map", "fleet/robot1/odom"])
})

Deno.test("a namespace's page sees its topics by plain names and the shared ones, never another robot's", () => {
    assertEquals(namespacedTopics(BUS, "robot0").map((one) => one.key), [
        "dimos/odom/nav_msgs.Odometry",
        "dimos/cmd_vel/geometry_msgs.Twist",
        "dimos/global_map/sensor_msgs.PointCloud2",
        "dimos/file_info/std_msgs.String",
        "dimos/file_info/go2/std_msgs.String",
    ])
    assertEquals(namespacedTopics(BUS, ""), BUS)
})

Deno.test("frames lose the namespace coming in and get it back going out; shared frames stay shared", () => {
    forgetFrames()
    const tf = { transforms: [{ header: { frame_id: "robot1/odom" }, child_frame_id: "robot1/base_link" }, { header: { frame_id: "world" }, child_frame_id: "robot1/odom" }] }
    stripFrames(tf, "robot1")
    assertEquals(tf.transforms.map((one) => [one.header.frame_id, one.child_frame_id]), [["odom", "base_link"], ["world", "odom"]])
    const goal = { header: { frame_id: "odom", stamp: { sec: 1 } }, pose: { position: { x: 1 } } }
    const sent = prefixFrames(goal, "robot1")
    assertEquals([sent.header.frame_id, goal.header.frame_id, sent.pose === goal.pose], ["robot1/odom", "odom", true])
    assertEquals(prefixFrames({ header: { frame_id: "world" } }, "robot1").header.frame_id, "world")
    // bytes are never walked
    const cloud = { header: { frame_id: "robot1/lidar" }, data: new Uint8Array(4) }
    assertEquals(stripFrames(cloud, "robot1").header.frame_id, "lidar")
})

Deno.test("the client maps every key: subscribe (and the messages' keys back), publisher, put, the lease", () => {
    const calls: unknown[][] = []
    const raw = {
        state: "connected",
        subscribe(key: string, _options: unknown, callback: (message: { key: string }) => void) {
            calls.push(["subscribe", key])
            callback({ key })
        },
        publisher: (key: string) => calls.push(["publisher", key]),
        put: (key: string) => calls.push(["put", key]),
        lease: (options: { publish: string[] }) => calls.push(["lease", options.publish]),
        listTopics: (filter: string) => calls.push(["listTopics", filter]),
    }
    const client = namespacedClient(raw, "robot0")
    const heard: string[] = []
    client.subscribe("dimos/odom/nav_msgs.Odometry", {}, (message) => heard.push(message.key))
    client.publisher("dimos/cmd_vel/geometry_msgs.Twist")
    client.put("dimos/goal/geometry_msgs.PoseStamped")
    client.lease({ publish: ["dimos/cmd_vel/geometry_msgs.Twist"] })
    client.listTopics("dimos/**")
    assertEquals(calls, [
        ["subscribe", "dimos/robot0/odom/nav_msgs.Odometry"],
        ["publisher", "dimos/robot0/cmd_vel/geometry_msgs.Twist"],
        ["put", "dimos/robot0/goal/geometry_msgs.PoseStamped"],
        ["lease", ["dimos/robot0/cmd_vel/geometry_msgs.Twist"]],
        ["listTopics", "dimos/**"],
    ])
    assertEquals([heard, client.state, namespacedClient(raw, "")], [["dimos/odom/nav_msgs.Odometry"], "connected", raw])
})
