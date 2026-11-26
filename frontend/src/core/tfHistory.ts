// A few seconds of every TF edge, so data can be placed with the transform from when it was seen (the live tree's
// lookup is the latest). A point cloud looks its frame up here once, at its own timestamp, and keeps that placement:
// odom moving at 50 Hz must not drag a 10 Hz scan along between scans. Stamps are tf's own (the header's), else the
// gateway's arrival time. The samples live in a TfGraph of their own (core/tf.ts), so a path is found the same way.
import type { Matrix4 } from "three"
import type { TfTree } from "dimos-react/three"
import { TF_HISTORY_MS, TfGraph } from "./tf.ts"

export { TF_HISTORY_MS }

export class TfHistory {
    #graph: TfGraph

    constructor(readonly tree: TfTree, readonly windowMs = TF_HISTORY_MS) {
        this.#graph = new TfGraph({ historyMs: windowMs })
    }

    /** Records T_parent_child at `stamp` (ms); rotation is x, y, z, w. */
    record(parent: string, child: string, translation: [number, number, number], rotation: [number, number, number, number], stamp: number, isStatic = false) {
        this.#graph.set(parent, child, translation, rotation, isStatic, stamp)
    }

    /**
     * Per edge on the path: the samples kept, and whether `stamp` falls inside them.
     *
     * A lookup outside an edge's range silently returns that edge's newest sample, which is the
     * "place it where the robot is now" behaviour the stamps exist to avoid -- and it looks
     * identical on screen to having no fix at all. This says which it is.
     */
    coverage(frame: string, fixed: string, stamp: number) {
        return this.#graph.coverage(frame, fixed, stamp)
    }

    /**
     * T_fixed_frame at `stamp`: each edge interpolated between its samples around it, or its newest sample when the
     * stamp is outside what's kept. Falls back to the live tree's (latest) lookup when this history has no path
     * (e.g. world/map standing in for each other with no tf). A new matrix each call: the caller may keep it.
     */
    lookupAt(frame: string, fixed: string, stamp: number): Matrix4 | null {
        if (frame !== fixed && frame !== "" && this.#graph.has(frame) && this.#graph.has(fixed)) {
            const placed = this.#graph.lookupAt(frame, fixed, stamp)
            if (placed) {
                return placed
            }
        }
        return this.tree.lookup(frame, fixed)?.clone() ?? null
    }
}
