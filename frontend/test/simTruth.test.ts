// tf_sim_truth (core/simTruth.ts): world_msgs.WorldObservations decoded from the bytes dimos_lcm's own Python encodes
// (dimos-lcm jeff/feat/sim2_world), bodies named by their "path" announcement or later, kept as a tf of their own
import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1"
import { Vector3 } from "three"
import { decode, encode } from "../src/core/lcm/lcm.ts"
import { cborText, SIM_WORLD, SimTruth } from "../src/core/simTruth.ts"

/** WorldObservations(ts=1.7e18, frame=3, entity 1 announced as path "go2" (cbor2.dumps), its BodyState at (1, 2, 0.5) turned 90° about z, moving 0.1 m/s in x and turning 0.2 rad/s), from dimos_lcm's lcm_encode() */
const FROM_PYTHON =
    "a3ddf661689afb4c17979cfe362a000000000000000000030000000100000000000000010000000570617468000000000463676f320000000100000000000000013ff000000000000040000000000000003fe0000000000000000000000000000000000000000000003fe6a09e667f3bcd3fe6a09e667f3bcd3fb999999999999a00000000000000000000000000000000000000000000000000000000000000003fc999999999999a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
const bytes = Uint8Array.from(FROM_PYTHON.match(/../g)!.map((hex) => parseInt(hex, 16)))

Deno.test("WorldObservations decode as dimos_lcm encodes them (fingerprint included), and encode back to the same bytes", () => {
    const message = decode("world_msgs.WorldObservations", bytes)
    assertEquals(message.frame, 3)
    assertEquals(message.cbor_key_values[0].key, "path")
    assertEquals(cborText(message.cbor_key_values[0].value), "go2")
    assertEquals(message.body_states[0].entity_id, 1)
    assertEquals([...message.body_states[0].pose].slice(0, 3), [1, 2, 0.5])
    assertEquals([...encode("world_msgs.WorldObservations", message)], [...bytes])
})

Deno.test("a body is a world → <path> edge of the truth's own tf, named by its announcement", () => {
    const truth = new SimTruth()
    truth.feed(decode("world_msgs.WorldObservations", bytes))
    assertEquals(truth.tf.frames(), ["go2", SIM_WORLD])
    const origin = new Vector3().applyMatrix4(truth.tf.lookup("go2", SIM_WORLD)!)
    assertAlmostEquals(origin.x, 1)
    assertAlmostEquals(origin.y, 2)
    const ahead = new Vector3(1, 0, 0).applyMatrix4(truth.tf.lookup("go2", SIM_WORLD)!)
    assertAlmostEquals(ahead.y, 3, 1e-9, "turned 90°: its x is the world's y")
    assertEquals(truth.bodies.get(1)?.velocity, [0.1, 0, 0, 0, 0, 0.2])
})

Deno.test("a page that joined late: an unnamed body is drawn by its id until the sim's snapshot names it; a gap in frames is counted", () => {
    const truth = new SimTruth()
    const body = { entity_id: 7, pose: [3, 0, 0, 0, 0, 0, 1], velocity: [0, 0, 0, 0, 0, 0], acceleration: [0, 0, 0, 0, 0, 0] }
    truth.feed({ ts: 0, frame: 10, cbor_key_values: [], body_states: [body], joint_states: [] })
    assertEquals(truth.unnamed(), [7])
    assertEquals(truth.tf.has("entity_7"), true)
    truth.name(7, "spot")
    assertEquals(truth.unnamed(), [])
    assertAlmostEquals(new Vector3().applyMatrix4(truth.tf.lookup("spot", SIM_WORLD)!).x, 3)
    truth.feed({ ts: 0, frame: 13, cbor_key_values: [], body_states: [], joint_states: [] })
    assertEquals(truth.missed, 2)
})

Deno.test("cbor text: short, one-byte and two-byte lengths; anything else is not a name", () => {
    assertEquals(cborText([0x63, 0x67, 0x6f, 0x32]), "go2")
    const long = "a".repeat(30)
    assertEquals(cborText([0x78, 30, ...new TextEncoder().encode(long)]), long)
    assertEquals(cborText([0x79, 0, 3, 0x61, 0x62, 0x63]), "abc")
    assertEquals(cborText([0x01]), null)
    assertEquals(cborText([0x65, 0x61]), null, "cut short")
})
