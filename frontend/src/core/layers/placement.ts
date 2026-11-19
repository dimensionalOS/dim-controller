// Where a 3D layer's data is drawn, per layer (the Layers list's "Placement" row): TF attached rides its frame (the
// latest tf, every frame, so it moves as the frame does), Instant stays where its frame was when the message was
// stamped (tf's history at the header's stamp, so a scan of a wall stays on the wall while the robot drives past).
// One lookup for every layer: placementMatrix. Pure apart from the tf it reads: test/placement.test.ts.
import type { Matrix4 } from "three"
import type { TfTree } from "dimos-react/three"
import type { TfHistory } from "../tfHistory.ts"

export type Placement = "attached" | "instant"

export const PLACEMENTS: readonly (readonly [Placement, string])[] = [["attached", "TF attached"], ["instant", "Instant"]]

/** A message header's stamp in ms (tf's clock, as tf itself is recorded), null without one. */
// deno-lint-ignore no-explicit-any
export function stampMsOf(message: any): number | null {
    const stamp = message?.header?.stamp
    const sec = Number(stamp?.sec ?? 0)
    const nsec = Number(stamp?.nsec ?? stamp?.nanosec ?? 0)
    return Number.isFinite(sec) && sec > 0 ? sec * 1000 + nsec / 1e6 : null
}

/** T_fixed_frame for data in `frame` stamped `stampMs`: attached = tf's latest, instant = tf as of the stamp (its latest without one). */
export function placementMatrix(tf: { tf: TfTree; tfHistory: TfHistory }, placement: Placement, frame: string, fixedFrame: string, stampMs: number | null): Matrix4 | null {
    if (placement === "instant" && stampMs !== null) {
        return tf.tfHistory.lookupAt(frame, fixedFrame, stampMs)
    }
    return tf.tf.lookup(frame, fixedFrame)
}
