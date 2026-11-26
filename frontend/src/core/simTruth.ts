// A simulated world's true poses (dimos sim2's world_observations: world_msgs.WorldObservations, a BodyState per body
// in the world frame), as a tf of their own: tf_sim_truth, an edge world → <entity path> per body, never mixed into the
// estimated tf. Entities are named once, when the world starts (a "path" CborKeyValue); a page that joins later asks
// the sim for its snapshot (the backend's api/sim/entities) and names the ids it hasn't heard named. Pure: no DOM.
import { TfGraph } from "./tf.ts"

/** the truth's own root: the sim's world frame (entity 0) */
export const SIM_WORLD = "world"
/** the key an entity's name comes under */
const PATH = "path"

export interface TruthBody {
    id: number
    /** its name, null until it's heard */
    path: string | null
    /** x, y, z, qx, qy, qz, qw in the world frame */
    pose: number[]
    /** linear then angular, world axes */
    velocity: number[]
    acceleration: number[]
}

export class SimTruth {
    readonly tf = new TfGraph()
    readonly bodies = new Map<number, TruthBody>()
    readonly paths = new Map<number, string>([[0, SIM_WORLD]])
    /** the last frame number seen, and how many frames were missed (a gap in the numbers) */
    frame = -1
    missed = 0
    /** WorldObservations.ts in ms (sim time plus the wall time the sim started at) */
    stampMs = 0

    // deno-lint-ignore no-explicit-any -- a decoded world_msgs.WorldObservations
    feed(message: any) {
        const frame = Number(message?.frame ?? -1)
        if (this.frame >= 0 && frame > this.frame + 1) {
            this.missed += frame - this.frame - 1
        }
        this.frame = frame
        this.stampMs = Number(message?.ts ?? 0) / 1e6
        for (const entry of message?.cbor_key_values ?? []) {
            if (entry.key === PATH) {
                const path = cborText(entry.value)
                if (path !== null) {
                    this.name(Number(entry.entity_id), path)
                }
            }
        }
        for (const state of message?.body_states ?? []) {
            const id = Number(state.entity_id)
            const body: TruthBody = { id, path: this.paths.get(id) ?? null, pose: [...state.pose], velocity: [...state.velocity], acceleration: [...state.acceleration] }
            this.bodies.set(id, body)
            this.#place(body)
        }
    }

    /** Names an entity (an announcement, or the sim's snapshot); its pose moves onto its name. */
    name(id: number, path: string) {
        if (this.paths.get(id) === path) {
            return
        }
        this.paths.set(id, path)
        const body = this.bodies.get(id)
        if (body) {
            body.path = path
            this.#place(body)
        }
    }

    /** the frame a body is drawn as: its path, else its id */
    frameOf(body: TruthBody): string {
        return body.path ?? `entity_${body.id}`
    }

    #place(body: TruthBody) {
        const [x, y, z, qx, qy, qz, qw] = body.pose
        const frame = this.frameOf(body)
        if (frame !== SIM_WORLD) {
            this.tf.set(SIM_WORLD, frame, [x, y, z], [qx, qy, qz, qw], false, this.stampMs)
        }
    }

    /** ids with a pose but no name yet */
    unnamed(): number[] {
        return [...this.bodies.values()].filter((body) => body.path === null).map((body) => body.id)
    }
}

/** A CBOR text string (major type 3, as cbor2.dumps(str) writes it), else null. */
export function cborText(bytes: Uint8Array | number[]): string | null {
    const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes)
    if (!data.length || data[0] >> 5 !== 3) {
        return null
    }
    const info = data[0] & 0x1f
    let length = info, at = 1
    if (info === 24) {
        length = data[1]
        at = 2
    } else if (info === 25) {
        length = (data[1] << 8) | data[2]
        at = 3
    } else if (info === 26) {
        length = ((data[1] << 24) >>> 0) + (data[2] << 16) + (data[3] << 8) + data[4]
        at = 5
    } else if (info > 26) {
        return null
    }
    if (at + length > data.length) {
        return null
    }
    return new TextDecoder().decode(data.subarray(at, at + length))
}
