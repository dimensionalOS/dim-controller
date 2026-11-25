// Each dimos HardwareModule's own USD (core/hardwareFiles.ts) drawn at its root frame from tf, one model per module namespace (no composed world)
import * as THREE from "three"
import { registerLayer, type LayerContext } from "../core/layers/registry.ts"
import { type Store, useStore } from "../core/store.ts"
import { Field, Slider, Toggle } from "dimos-react"
import { Kinematics, RobotModel } from "../core/robotDescription.ts"
import { type HardwareModule, type HardwareSource, hardwareSource, moduleFrame, modulePoses } from "../core/hardwareFiles.ts"
import { FILE_INFO_TYPE } from "../core/fileInfo.ts"
import { rendering } from "../core/render/rendering.ts"
import { applyMeshStyle } from "../core/render/meshStyle.ts"

export interface HardwareModelSettings {
    opacity: number
    /** visual meshes in their materials, or plain flat grey */
    textures: boolean
}

interface Drawn {
    module: HardwareModule
    kinematics: Kinematics
    model: RobotModel
}

class HardwareModelLayer {
    readonly root = new THREE.Group()
    #source: HardwareSource
    #release: () => void
    #stops: (() => void)[] = []
    #drawn = new Map<string, Drawn>()
    /** what the models were last placed for: placed again only when one of these moves */
    #placedFor = { tf: -1, fixed: "", models: -1 }
    #models = 0
    #unplaced: string[] = []

    constructor(readonly context: LayerContext, readonly settings: Store<HardwareModelSettings>) {
        this.root.matrixAutoUpdate = false
        this.#source = hardwareSource(context.connection, context.tf)
        this.#release = this.#source.acquire()
        this.#stops.push(this.#source.state.subscribe(() => this.#sync()))
        this.#stops.push(settings.subscribe(() => this.#rebuildAll()))
        this.#stops.push(rendering.subscribe(() => this.#applyMeshStyle()))
        this.#sync()
    }

    #sync() {
        const { modules } = this.#source.state.get()
        for (const [namespace, drawn] of this.#drawn) {
            if (modules.get(namespace) !== drawn.module) {
                this.#remove(namespace)
            }
        }
        for (const module of modules.values()) {
            const drawn = this.#drawn.get(module.namespace)
            if (!drawn && module.description) {
                this.#build(module)
            } else if (drawn?.model.fill(module.geometries)) {
                this.#applyMeshStyle()
            }
        }
        this.#models++
        this.context.viewer.requestRender()
        this.#status()
    }

    #build(module: HardwareModule) {
        const kinematics = new Kinematics(module.description!)
        const { opacity, textures } = this.settings.get()
        const model = new RobotModel(kinematics, module.geometries, { opacity }, undefined, module.textures)
        model.setTextures(textures ?? true)
        model.root.visible = false
        this.root.add(model.root)
        this.#drawn.set(module.namespace, { module, kinematics, model })
        this.#applyMeshStyle()
    }

    #remove(namespace: string) {
        const drawn = this.#drawn.get(namespace)!
        this.root.remove(drawn.model.root)
        drawn.model.dispose()
        this.#drawn.delete(namespace)
    }

    #rebuildAll() {
        for (const namespace of [...this.#drawn.keys()]) {
            this.#remove(namespace)
        }
        this.#sync()
    }

    /** Settings → Meshes: solid or wireframe (core/render/meshStyle.ts) */
    #applyMeshStyle() {
        const { meshStyle, wireframeColor } = rendering.get()
        for (const { model } of this.#drawn.values()) {
            applyMeshStyle(model.root, meshStyle, wireframeColor)
        }
        this.context.viewer.requestRender()
    }

    #status() {
        const modules = [...this.#source.state.get().modules.values()]
        if (!modules.length) {
            this.context.setStatus({ info: "waiting for a HardwareModule (hardware.usda asked for under each tf frame's namespace)", problem: null })
            return
        }
        const wanted = modules.reduce((sum, module) => sum + module.files.length, 0)
        const loaded = modules.reduce((sum, module) => sum + module.geometries.size + module.textures.size, 0)
        const problems = modules.filter((module) => module.problem).map((module) => module.problem)
        const unplaced = this.#unplaced.length ? `no tf for ${this.#unplaced.join(", ")}` : null
        this.context.setStatus({
            info: `${modules.length} module${modules.length === 1 ? "" : "s"} (${modules.map((module) => module.namespace || "/").join(", ")}) · files ${loaded}/${wanted}`,
            problem: [...problems, unplaced].filter(Boolean).join("; ") || null,
        })
    }

    update(frame: { fixedFrame: string }) {
        const tf = this.context.tf
        if (tf.version === this.#placedFor.tf && frame.fixedFrame === this.#placedFor.fixed && this.#models === this.#placedFor.models) {
            return
        }
        this.#placedFor = { tf: tf.version, fixed: frame.fixedFrame, models: this.#models }
        const unplaced: string[] = []
        for (const { kinematics, model } of this.#drawn.values()) {
            const poses = modulePoses(kinematics, (name) => tf.lookup(name, frame.fixedFrame))
            model.root.visible = !!poses
            if (!poses) {
                unplaced.push(moduleFrame(kinematics.root))
                continue
            }
            for (const [link, group] of model.links) {
                const pose = poses.get(link)
                group.visible = !!pose
                if (pose && !group.matrix.equals(pose)) {
                    group.matrix.copy(pose)
                    group.matrixWorldNeedsUpdate = true
                }
            }
        }
        if (unplaced.join() !== this.#unplaced.join()) {
            this.#unplaced = unplaced
            this.#status()
        }
        this.context.viewer.requestRender()
    }

    dispose() {
        this.#stops.splice(0).forEach((stop) => stop())
        this.#release()
        for (const namespace of [...this.#drawn.keys()]) {
            this.#remove(namespace)
        }
    }
}

function HardwareModelSettingsEditor({ settings }: { settings: Store<HardwareModelSettings> }) {
    const value = useStore(settings)
    return (
        <>
            <Field inline label="Opacity">
                <Slider min={0.1} max={1} step={0.05} value={value.opacity} format={(opacity: number) => `${Math.round(opacity * 100)}%`} onChange={(opacity: number) => settings.update({ opacity })} />
            </Field>
            <Field inline label="Textures"><Toggle value={value.textures ?? true} onChange={(textures: boolean) => settings.update({ textures })} /></Field>
        </>
    )
}

registerLayer<HardwareModelSettings>({
    id: "hardware-model",
    // posed by tf, link by link: always where tf has it now
    placement: false,
    label: "Hardware (USD per module)",
    types: [FILE_INFO_TYPE],
    names: ["/hardware_file_response"],
    defaults: { opacity: 1, textures: true },
    create: (context, _topic, settings) => new HardwareModelLayer(context, settings),
    Settings: HardwareModelSettingsEditor,
})
