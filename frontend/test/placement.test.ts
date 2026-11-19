// Where a 3D layer's data is drawn (core/layers/placement.ts): TF attached is tf's latest, Instant is tf as of the
// message's own stamp (tf's latest when it has none).
import { assertEquals } from "jsr:@std/assert@1"
import * as THREE from "three"
import { placementMatrix, stampMsOf } from "../src/core/layers/placement.ts"

const latest = new THREE.Matrix4().makeTranslation(5, 0, 0)
const then = new THREE.Matrix4().makeTranslation(1, 0, 0)
const asked: number[] = []
// deno-lint-ignore no-explicit-any
const tf: any = {
    tf: { lookup: () => latest },
    tfHistory: { lookupAt: (_frame: string, _fixed: string, stamp: number) => (asked.push(stamp), then) },
}

Deno.test("a header's stamp in ms, none without one", () => {
    assertEquals(stampMsOf({ header: { stamp: { sec: 2, nsec: 500_000_000 } } }), 2500)
    assertEquals(stampMsOf({ header: { stamp: { sec: 0, nsec: 0 } } }), null)
    assertEquals(stampMsOf({}), null)
})

Deno.test("TF attached is tf's latest; Instant is tf as of the stamp, its latest without one", () => {
    assertEquals(placementMatrix(tf, "attached", "lidar", "map", 2500), latest)
    assertEquals(placementMatrix(tf, "instant", "lidar", "map", 2500), then)
    assertEquals(asked, [2500])
    assertEquals(placementMatrix(tf, "instant", "lidar", "map", null), latest)
})
