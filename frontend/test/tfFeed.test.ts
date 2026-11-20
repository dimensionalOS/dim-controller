// core/tfFeed.ts: tf comes in twice (reliable for every edge, latest for a current tree), and the reliable backlog
// arriving late never pulls an edge back in time.
import { assertEquals } from "jsr:@std/assert@1"
import { Vector3 } from "three"
import { TfTree } from "dimos-react/three"
import type { Viewer } from "dimos-react/three"
import { TfHistory } from "../src/core/tfHistory.ts"
import { feedTf } from "../src/core/tfFeed.ts"
import { Store } from "../src/core/store.ts"
import { encode } from "../src/core/lcm/lcm.ts"
import type { Connection, Message, SubscribeOptions } from "../src/core/transport.ts"

function tfMessage(x: number, sec: number) {
    return encode("tf2_msgs.TFMessage", {
        transforms_length: 1,
        transforms: [{
            header: { seq: 0, stamp: { sec, nsec: 0 }, frame_id: "map" },
            child_frame_id: "base_link",
            transform: { translation: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
        }],
    })
}

Deno.test("tf: subscribed reliable and latest; a late reliable message doesn't move an edge back", () => {
    const subscriptions: { options: SubscribeOptions; onMessage: (message: Message) => void }[] = []
    const status = new Store({ topics: [{ key: "dimos/tf/tf2_msgs.TFMessage", name: "/tf", type: "tf2_msgs.TFMessage" }] })
    const connection = { status, subscribe: (_key: string, options: SubscribeOptions, onMessage: (message: Message) => void) => (subscriptions.push({ options, onMessage }), () => {}) }
    const tree = new TfTree()
    feedTf(connection as unknown as Connection, tree, { noteData: () => {} } as unknown as Viewer, new TfHistory(tree))
    assertEquals(subscriptions.map((subscription) => subscription.options.delivery), ["reliable", "latest"])
    const [reliable, latest] = subscriptions
    const x = () => new Vector3().applyMatrix4(tree.lookup("base_link", "map")!).x
    latest.onMessage({ bytes: tfMessage(5, 105), timestamp: 0 } as Message)
    reliable.onMessage({ bytes: tfMessage(1, 101), timestamp: 0 } as Message)
    assertEquals(x(), 5)
    reliable.onMessage({ bytes: tfMessage(6, 106), timestamp: 0 } as Message)
    assertEquals(x(), 6)
})
