// tf_sim_truth: a simulated world's true poses (world_msgs.WorldObservations' BodyStates, core/simTruth.ts) drawn as
// their own layer: axes and a name per body at the pose the sim has it, with how far tf's estimate of the same frame
// is from it. The truth's world is placed by the estimated tf's frame of that name (Settings: World frame).
import * as THREE from "three"
import { registerLayer, type LayerContext } from "../core/layers/registry.ts"
import { decode } from "../core/lcm/lcm.ts"
import { FatLines, LabelPool } from "dimos-react/three"
import { useStore, type Store } from "../core/store.ts"
import type { Topic } from "../core/transport.ts"
import { SIM_WORLD, SimTruth } from "../core/simTruth.ts"
import { Field, Slider, TextInput, Toggle } from "dimos-react"

export interface SimTruthSettings {
    axesSize: number
    names: boolean
    /** the estimated tf's frame the sim's world is drawn at */
    worldFrame: string
}

/** How far apart two poses' origins are (m). */
export function offsetMeters(truth: THREE.Matrix4, estimate: THREE.Matrix4): number {
    return new THREE.Vector3().setFromMatrixPosition(truth).distanceTo(new THREE.Vector3().setFromMatrixPosition(estimate))
}

class SimTruthLayer {
    readonly root = new THREE.Group()
    readonly truth = new SimTruth()
    #axes: FatLines
    #labels = new LabelPool("dr-scene-label dr-frame-label")
    #stop: () => void
    #version = -1
    #estimateVersion = -1
    #fixedFrame = ""
    #asking = false
    #askedFor = ""

    constructor(readonly context: LayerContext, readonly topic: Topic, readonly settings: Store<SimTruthSettings>) {
        this.#axes = new FatLines(context.viewer.resolution, { width: 3, vertexColors: true, dashed: true, capacity: 512 * 3 })
        this.root.add(this.#axes.object, this.#labels.group)
        // every message (reliable, at the source's rate): a body is only sent when it moved, and its name only once
        this.#stop = context.connection.subscribe(topic.key, { delivery: "reliable" }, (message) => {
            try {
                this.truth.feed(decode(topic.type, message.bytes))
            } catch (error) {
                context.setStatus({ problem: `cannot decode ${topic.type}: ${error}` })
                return
            }
            this.#askNames()
            context.viewer.requestRender()
        })
        settings.subscribe(() => {
            this.#version = -1
            context.viewer.requestRender()
        })
    }

    /** a body heard before its name (the page joined late): the sim's snapshot names it; asked again only when another such id turns up */
    #askNames() {
        const unnamed = this.truth.unnamed()
        const key = unnamed.join(",")
        if (!unnamed.length || this.#asking || key === this.#askedFor) {
            return
        }
        this.#asking = true
        this.#askedFor = key
        fetch("api/sim/entities").then((response) => response.ok ? response.json() : null).then((answer) => {
            for (const [id, path] of Object.entries((answer?.entities ?? {}) as Record<string, string>)) {
                this.truth.name(Number(id), path)
            }
            this.context.viewer.requestRender()
        }).catch(() => {}).finally(() => {
            this.#asking = false
        })
    }

    update(frame: { fixedFrame: string }) {
        if (this.truth.tf.version === this.#version && this.context.tf.version === this.#estimateVersion && frame.fixedFrame === this.#fixedFrame) {
            return
        }
        this.#version = this.truth.tf.version
        this.#estimateVersion = this.context.tf.version
        this.#fixedFrame = frame.fixedFrame
        const settings = this.settings.get()
        const world = this.context.tf.lookup(settings.worldFrame || SIM_WORLD, frame.fixedFrame)
        this.#axes.clear()
        this.#labels.begin()
        if (!world) {
            this.#axes.commit()
            this.#labels.end()
            this.context.setStatus({ problem: `"${settings.worldFrame}" isn't connected to "${frame.fixedFrame}": the truth can't be placed`, frame: settings.worldFrame })
            return
        }
        const red = new THREE.Color(0xef4444), green = new THREE.Color(0x22c55e), blue = new THREE.Color(0x3b82f6)
        const origin = new THREE.Vector3(), tip = new THREE.Vector3()
        let off = 0
        for (const body of this.truth.bodies.values()) {
            const name = this.truth.frameOf(body)
            const inWorld = this.truth.tf.lookup(name, SIM_WORLD)
            if (!inWorld) {
                continue
            }
            const matrix = world.clone().multiply(inWorld)
            origin.setFromMatrixPosition(matrix)
            for (const [axis, color] of [[new THREE.Vector3(1, 0, 0), red], [new THREE.Vector3(0, 1, 0), green], [new THREE.Vector3(0, 0, 1), blue]] as const) {
                tip.copy(axis).multiplyScalar(settings.axesSize).applyMatrix4(matrix)
                this.#axes.push(origin.x, origin.y, origin.z, tip.x, tip.y, tip.z, color)
            }
            const estimate = this.context.tf.has(name) ? this.context.tf.lookup(name, frame.fixedFrame) : null
            const gap = estimate ? offsetMeters(matrix, estimate) : null
            if (gap !== null && gap > 0.05) {
                off++
            }
            if (settings.names) {
                this.#labels.place(`truth ${name}${gap === null ? "" : ` (tf ${gap.toFixed(2)} m off)`}`, origin)
            }
        }
        this.#axes.commit()
        this.#labels.end()
        const missed = this.truth.missed ? `, ${this.truth.missed} frames missed` : ""
        this.context.setStatus({ info: `${this.truth.bodies.size} bodies, frame ${this.truth.frame}${missed}`, problem: off ? `tf is over 5 cm from the truth for ${off} of them` : null, frame: settings.worldFrame })
        this.context.viewer.requestRender()
    }

    dispose() {
        this.#stop()
        this.#axes.dispose()
        this.#labels.dispose()
    }
}

function SimTruthSettingsEditor({ settings }: { settings: Store<SimTruthSettings>; topic: Topic }) {
    const value = useStore(settings)
    return (
        <>
            <Field inline label="Axes"><Slider min={0.05} max={2} step={0.05} value={value.axesSize} format={(size: number) => `${size} m`} onChange={(axesSize: number) => settings.update({ axesSize })} /></Field>
            <Field inline label="Names"><Toggle value={value.names} onChange={(names: boolean) => settings.update({ names })} /></Field>
            <Field inline label="World frame" title="the tf frame the sim's world is drawn at"><TextInput value={value.worldFrame} onChange={(worldFrame: string) => settings.update({ worldFrame })} /></Field>
        </>
    )
}

registerLayer<SimTruthSettings>({
    id: "tf_sim_truth",
    // the truth is in the sim's world: placed by the World frame setting, not a header
    placement: false,
    label: "tf_sim_truth",
    types: ["world_msgs.WorldObservations"],
    defaults: { axesSize: 0.4, names: true, worldFrame: SIM_WORLD },
    create: (context: LayerContext, topic, settings) => new SimTruthLayer(context, topic, settings),
    Settings: SimTruthSettingsEditor,
})
