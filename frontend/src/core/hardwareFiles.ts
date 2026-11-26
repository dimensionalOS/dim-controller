// Each dimos HardwareModule's own USD and assets (dimos/core/hardware_module.py), one model per module namespace, found from tf with no polling
// A new frame `a/b/link` asks hardware.usda on a/b, a and the top level's hardware_file_request; every answer comes on **/hardware_file_response
import type * as THREE from "three"
import { meshGeometry, meshTextures, meshUris, type TfTree } from "dimos-react/three"
import type { Kinematics } from "./robotDescription.ts"
import { Store } from "./store.ts"
import { type Connection, dimosKey, Priority, type Publisher } from "./transport.ts"
import { decodeFileInfo, encodeFileInfo, FILE_INFO_TYPE, type FileInfo } from "./fileInfo.ts"
import { cachedBytes, knownHash, rememberHash, storeBytes } from "./hardwareCache.ts"
import { framesFromPrimPaths, usdAssetHashes, usdParser, usdPrimPaths } from "./usd.ts"
import { imageTexture, isImage } from "./imageTexture.ts"
import { meshLog } from "./meshCache.ts"
import { stripFrame } from "./namespace.ts"
import type { RobotDescription } from "./robotDescription.ts"
import type { TfGraph } from "./tf.ts"

/** the name every HardwareModule serves its USD as */
export const HARDWARE_USD = "hardware.usda"
/** every module's answers, at any depth (zenoh's `**` also matches none: the top level's) */
export const HARDWARE_RESPONSES = dimosKey("/**/hardware_file_response", FILE_INFO_TYPE)
/** the layer list's one entry for all modules (the top level's response topic, listed whether or not it exists) */
export const HARDWARE_TOPIC = dimosKey("/hardware_file_response", FILE_INFO_TYPE)

/** where the module in `namespace` takes requests ("" = the top level) */
export const requestKey = (namespace: string) => dimosKey(`${namespace}/hardware_file_request`, FILE_INFO_TYPE)

/** `dimos/go2/lidar/hardware_file_response/files.FileInfo` → go2/lidar, the top level's → "", anything else → null */
export function namespaceOfKey(key: string): string | null {
    const match = key.match(/^dimos\/(?:(.+)\/)?hardware_file_response\/files\.FileInfo$/)
    return match ? (match[1] ?? "") : null
}

/** the namespaces a frame could be a module's frame in, innermost first: `a/b/link` → a/b, a, "" */
export function framePrefixes(frame: string): string[] {
    const parts = frame.split("/").filter(Boolean).slice(0, -1)
    return parts.map((_, index) => parts.slice(0, parts.length - index).join("/")).concat("")
}

/** a link's tf frame: its prim path (framesFromPrimPaths), the page's own namespace off as it is off tf's */
export const moduleFrame = (link: string) => stripFrame(link)

/** Every link of a module's USD in the fixed frame: at its own tf frame, else its root's through the joints; null while tf has no root frame. */
export function modulePoses(kinematics: Kinematics, inFixed: (frame: string) => THREE.Matrix4 | null): Map<string, THREE.Matrix4> | null {
    const at = (link: string) => inFixed(moduleFrame(link))
    const rootPose = at(kinematics.root)
    if (!rootPose) {
        return null
    }
    const relative = (child: string, parent: string) => {
        const childPose = at(child), parentPose = at(parent)
        return childPose && parentPose ? parentPose.clone().invert().multiply(childPose) : null
    }
    const poses = new Map<string, THREE.Matrix4>()
    for (const [link, pose] of kinematics.linkPoses(kinematics.positionsFrom(relative))) {
        poses.set(link, at(link) ?? rootPose.clone().multiply(pose))
    }
    return poses
}

export interface HardwareModule {
    namespace: string
    /** its hardware.usda's hash as last announced or served (null: it gave none) */
    sha256: string | null
    /** null until its USD is read */
    description: RobotDescription | null
    /** its meshes and images by the uri its USD names (relative to the module), filled in as they come */
    geometries: Map<string, THREE.BufferGeometry>
    textures: Map<string, THREE.Texture>
    /** every file its USD names, and the images its mesh layers name (relative to the module) */
    files: string[]
    /** files the module names but answered it can't serve (a header with no sha256) */
    unservable: Set<string>
    /** every prim of its USD as a tf frame (its prim path): the frames tf calls hardware (core/tf.ts) */
    frames: string[]
    /** its hardware.usda's text, and the sublayers it names (as authored) with those that have come in */
    source: string
    layers: Map<string, string>
    problem: string | null
}

export interface HardwareState {
    modules: ReadonlyMap<string, HardwareModule>
    /** bumped on every change, a file coming in included */
    version: number
}

const nameKey = (namespace: string, uri: string) => `${namespace}\n${uri}`
const splitName = (key: string) => {
    const at = key.indexOf("\n")
    return { namespace: key.slice(0, at), uri: key.slice(at + 1) }
}
const blank = (namespace: string, sha256: string | null, problem: string | null = null): HardwareModule => ({ namespace, sha256, description: null, geometries: new Map(), textures: new Map(), files: [], unservable: new Set(), frames: [], problem, source: "", layers: new Map() })

export class HardwareSource {
    readonly state = new Store<HardwareState>({ modules: new Map(), version: 0 })
    #users = 0
    #stops: (() => void)[] = []
    #publishers = new Map<string, Publisher>()
    /** the subscription is open: requests can be answered */
    #open = false
    #scanQueued = false
    /** frames already looked at */
    #frames = new Set<string>()
    /** requests without a reply yet, by nameKey: sent again on a reconnect */
    #outstanding = new Map<string, { namespace: string; uri: string; sha256?: string }>()
    /** sha256 → the module files (nameKey) waiting for those bytes, so a file two modules share is asked for once */
    #waiting = new Map<string, Set<string>>()
    /** sha256 → its mesh or image, decoded once for every module that names it */
    #decoded = new Map<string, Promise<THREE.BufferGeometry | THREE.Texture | string>>()
    /** module files already said in the console to be unservable */
    #saidUnservable = new Set<string>()

    /**
     * This app's backend (server/src/hardware.rs): every module file it heard on the bus or read from a recording, by
     * sha256. Asked after IndexedDB and before the module, so a replay (no module running) still draws the hardware.
     * Tests put a fake in its place.
     */
    backend: (path: string) => Promise<Response> = async (path) => await fetch(new URL(path, globalThis.location?.href).href)
    /** the backend's modules (namespace → uri → sha256), asked once per acquire */
    #backendModules: Promise<Record<string, Record<string, string>>> | null = null

    constructor(readonly connection: Connection, readonly tf: TfTree) {}

    /** a file's bytes from the backend's cache, null when it hasn't them (or there's no backend) */
    async #fromBackend(sha256: string): Promise<Uint8Array | null> {
        try {
            const response = await this.backend(`api/hardware/files/${encodeURIComponent(sha256)}`)
            return response.ok ? new Uint8Array(await response.arrayBuffer()) : null
        } catch {
            return null
        }
    }

    /** the hash the backend knows `namespace`'s hardware.usda by, or null */
    async #backendUsd(namespace: string): Promise<string | null> {
        this.#backendModules ??= this.backend("api/hardware").then((response) => response.ok ? response.json() : {}).then((answer: { modules?: Record<string, Record<string, string>> }) => answer?.modules ?? {}).catch(() => ({}))
        return (await this.#backendModules)[namespace]?.[HARDWARE_USD] ?? null
    }

    /** Starts listening (first user); the returned function lets go (the last one stops it, keeping what's loaded). */
    acquire(): () => void {
        if (this.#users++ === 0) {
            const handle = this.connection.subscribe(HARDWARE_RESPONSES, { delivery: "reliable", compress: "zstd", priority: Priority.BACKGROUND, bandwidthPriority: 0.2 }, (message) => this.#onMessage(message.key, message.bytes))
            const opened = () => {
                if (this.#users && !this.#open) {
                    this.#open = true
                    this.#outstanding.forEach((request) => this.#send(request))
                    // an announcement missed while away: every module drawn is asked whether its USD is still the one it has
                    for (const module of this.state.get().modules.values()) {
                        if (module.description && module.sha256 && !this.#outstanding.has(nameKey(module.namespace, HARDWARE_USD))) {
                            this.#request(module.namespace, HARDWARE_USD, module.sha256)
                        }
                    }
                    this.#scan()
                }
            }
            this.#stops.push(handle, this.tf.onChange(() => this.#queueScan()))
            let state = this.connection.status.get().state
            this.#stops.push(this.connection.status.subscribe(() => {
                const now = this.connection.status.get().state
                // what went out while the link was down is lost: sent again once the subscription is back
                const up = (name: string) => name === "connected" || name === "degraded"
                if (up(now) && !up(state)) {
                    handle.ready().then(opened)
                } else if (!up(now)) {
                    this.#open = false
                }
                state = now
            }))
            handle.ready().then(opened)
        }
        let released = false
        return () => {
            if (released) {
                return
            }
            released = true
            if (--this.#users === 0) {
                this.#backendModules = null
                this.#stops.splice(0).forEach((stop) => stop())
                this.#publishers.forEach((publisher) => publisher.close())
                this.#publishers.clear()
                this.#open = false
                this.#frames.clear()
                this.#outstanding.clear()
                this.#waiting.clear()
            }
        }
    }

    /** one scan per burst of tf changes (a message's transforms land one by one) */
    #queueScan() {
        if (!this.#open || this.#scanQueued) {
            return
        }
        this.#scanQueued = true
        queueMicrotask(() => {
            this.#scanQueued = false
            this.#scan()
        })
    }

    /** asks hardware.usda of every namespace a new frame could be in that hasn't answered yet */
    #scan() {
        const namespaces = new Set<string>()
        for (const frame of this.tf.frames()) {
            if (this.#frames.has(frame)) {
                continue
            }
            this.#frames.add(frame)
            for (const namespace of framePrefixes(frame)) {
                if (!this.state.get().modules.has(namespace)) {
                    namespaces.add(namespace)
                }
            }
        }
        namespaces.forEach((namespace) => this.#askForUsd(namespace))
    }

    /** with the hash of the copy kept, if one is: an unchanged USD then comes back as a header only */
    async #askForUsd(namespace: string) {
        const known = await knownHash(namespace, HARDWARE_USD)
        const kept = known && await cachedBytes(known) ? known : undefined
        if (this.#users && !this.state.get().modules.has(namespace)) {
            this.#request(namespace, HARDWARE_USD, kept)
        }
        // the backend may hold it (heard earlier, or read from a recording): drawn from there if no module answers first
        const held = kept ? null : await this.#backendUsd(namespace)
        if (held && this.#users && !this.state.get().modules.has(namespace)) {
            this.#onUsd(namespace, { ts: 0, uri: HARDWARE_USD, sha256: held })
        }
    }

    #request(namespace: string, uri: string, sha256?: string) {
        const request = { namespace, uri, ...(sha256 ? { sha256 } : {}) }
        this.#outstanding.set(nameKey(namespace, uri), request)
        if (this.#open) {
            this.#send(request)
        }
    }

    #send({ namespace, uri, sha256 }: { namespace: string; uri: string; sha256?: string }) {
        const client = this.connection.client
        const key = requestKey(namespace)
        try {
            if (client && !this.#publishers.has(key)) {
                this.#publishers.set(key, client.publisher(key, { delivery: "reliable" }))
            }
            this.#publishers.get(key)?.put(encodeFileInfo({ ts: Date.now() / 1000, uri, ...(sha256 ? { sha256 } : {}) }))
        } catch {
            // not connected: the reconnect sends it
        }
    }

    #onMessage(key: string, bytes: Uint8Array) {
        const namespace = namespaceOfKey(key)
        if (namespace === null) {
            return
        }
        let info: FileInfo
        try {
            info = decodeFileInfo(bytes)
        } catch (error) {
            meshLog(`${key}: ${error}`)
            return
        }
        if (info.uri === HARDWARE_USD) {
            this.#onUsd(namespace, info)
        } else {
            this.#onAsset(namespace, info)
        }
    }

    /** An announcement (header only), an unchanged reply (header only) or the USD itself: a hash not drawn replaces what's drawn there. */
    async #onUsd(namespace: string, info: FileInfo) {
        this.#outstanding.delete(nameKey(namespace, HARDWARE_USD))
        const sha256 = info.sha256 ?? null
        const drawn = this.state.get().modules.get(namespace)
        if (!this.#users || (drawn?.sha256 === sha256 && (drawn.description || drawn.problem))) {
            return
        }
        if (!sha256 && !info.content) {
            this.#sayUnservable(namespace, HARDWARE_USD)
            this.#setModule(blank(namespace, null, `${namespace || "the top level"} names ${HARDWARE_USD} but can't serve it (no pxr there?)`))
            return
        }
        this.#setModule(blank(namespace, sha256))
        const current = () => this.state.get().modules.get(namespace)?.sha256 === sha256 && !this.state.get().modules.get(namespace)?.description
        if (!info.content) {
            const kept = await cachedBytes(sha256!) ?? await this.#fromBackend(sha256!)
            if (current()) {
                if (kept) {
                    this.#useUsd(namespace, sha256, kept)
                } else {
                    this.#request(namespace, HARDWARE_USD)
                }
            }
            return
        }
        if (sha256 && await verified(sha256, info.content)) {
            await storeBytes(sha256, info.content)
            await rememberHash(namespace, HARDWARE_USD, sha256)
        }
        if (current()) {
            this.#useUsd(namespace, sha256, info.content)
        }
    }

    #useUsd(namespace: string, sha256: string | null, bytes: Uint8Array) {
        const parser = usdParser()
        if (!parser) {
            this.#setModule(blank(namespace, sha256, "this build's dimos-react has no USD parser"))
            return
        }
        const text = new TextDecoder().decode(bytes)
        this.#describe({ ...blank(namespace, sha256), source: text }, parser)
    }

    /** reads a module's USD with the sublayers in so far, and asks for those it names and hasn't got (each then reads it again) */
    #describe(base: HardwareModule, parser: NonNullable<ReturnType<typeof usdParser>>) {
        const { namespace, sha256, source: text, layers } = base
        let description: RobotDescription
        try {
            description = framesFromPrimPaths(parser.parseUsda(text, { layers }), [text, ...layers.values()])
        } catch (error) {
            this.#setModule(blank(namespace, sha256, `${namespace || "/"}${HARDWARE_USD}: ${error}`))
            return
        }
        // a sublayer's own sublayers are named as authored too, and composed under it
        const sublayers = [text, ...layers.values()].flatMap((layer) => parser.usdaSublayers?.(layer) ?? [])
        const missing = [...new Set(sublayers)].filter((path) => !layers.has(path))
        const hashes = usdAssetHashes(text, parser)
        const module: HardwareModule = { ...base, description, files: [...meshUris(description), ...missing], frames: usdPrimPaths([text, ...layers.values()]).map(moduleFrame), geometries: base.geometries, textures: base.textures }
        this.#setModule(module)
        meshLog(`hardware ${namespace || "(top level)"}: ${module.files.length} files, ${module.files.filter((uri) => hashes.has(uri)).length} hashed`)
        module.files.forEach((uri) => this.#wantAsset(module, uri, hashes.get(uri) ?? null))
    }

    /** a hashed file from what's decoded, then the cache, then the module (once however many modules wait for it); an unhashed one asked for conditionally */
    async #wantAsset(module: HardwareModule, uri: string, sha256: string | null) {
        const name = nameKey(module.namespace, uri)
        if (!sha256) {
            const known = await knownHash(module.namespace, uri)
            const kept = known && await cachedBytes(known) ? known : undefined
            if (this.#isWanted(module.namespace, uri)) {
                this.#request(module.namespace, uri, kept)
            }
            return
        }
        const decoded = this.#decoded.get(sha256)
        if (decoded) {
            this.#attach(module.namespace, uri, decoded)
            return
        }
        const waiting = this.#waiting.get(sha256)
        if (waiting) {
            waiting.add(name)
            return
        }
        this.#waiting.set(sha256, new Set([name]))
        const kept = await cachedBytes(sha256) ?? await this.#fromBackend(sha256)
        if (kept) {
            this.#deliver(module.namespace, uri, sha256, kept)
        } else if (this.#users) {
            this.#request(module.namespace, uri)
        }
    }

    /** a module's current USD names this file, it isn't in yet, and the module hasn't said it can't serve it */
    #isWanted(namespace: string, uri: string): boolean {
        const module = this.state.get().modules.get(namespace)
        return !!module?.files.includes(uri) && !module.geometries.has(uri) && !module.textures.has(uri) && !module.layers.has(uri) && !module.unservable.has(uri)
    }

    #sayUnservable(namespace: string, uri: string) {
        const name = nameKey(namespace, uri)
        if (!this.#saidUnservable.has(name)) {
            this.#saidUnservable.add(name)
            meshLog(`hardware ${namespace || "(top level)"} names ${uri} but can't serve it: not drawn`)
        }
    }

    /** a header with no sha256: given up on, uncached, and another module waiting for the same bytes asks its own */
    #onUnservable(namespace: string, uri: string) {
        this.#sayUnservable(namespace, uri)
        const module = this.state.get().modules.get(namespace)
        if (module?.files.includes(uri)) {
            module.unservable.add(uri)
            module.problem = `can't be served: ${[...module.unservable].join(", ")}`
            this.#changed()
        }
        const name = nameKey(namespace, uri)
        for (const [sha256, names] of this.#waiting) {
            if (names.delete(name)) {
                const next = [...names][0]
                if (next) {
                    this.#request(splitName(next).namespace, splitName(next).uri)
                } else {
                    this.#waiting.delete(sha256)
                }
            }
        }
    }

    async #onAsset(namespace: string, info: FileInfo) {
        const sha256 = info.sha256 ?? null
        // another page's answer, or a file nothing here waits for
        if (!this.#isWanted(namespace, info.uri) && !(sha256 && this.#waiting.has(sha256))) {
            return
        }
        this.#outstanding.delete(nameKey(namespace, info.uri))
        if (!sha256 && !info.content) {
            this.#onUnservable(namespace, info.uri)
            return
        }
        if (!info.content) {
            const kept = sha256 ? await cachedBytes(sha256) : null
            if (kept) {
                this.#deliver(namespace, info.uri, sha256, kept)
            } else {
                this.#request(namespace, info.uri)
            }
            return
        }
        if (sha256 && await verified(sha256, info.content)) {
            storeBytes(sha256, info.content)
            rememberHash(namespace, info.uri, sha256)
        }
        this.#deliver(namespace, info.uri, sha256, info.content)
    }

    /** decodes the bytes once and hands them to this module file and every other one waiting for the same hash */
    #deliver(namespace: string, uri: string, sha256: string | null, bytes: Uint8Array) {
        // a sublayer is text for the USD to be read again with; anything else is a mesh or an image
        const sublayer = [...this.state.get().modules.values()].some((module) => module.namespace === namespace && module.description && this.#sublayerOf(module, uri))
        const decoded = (sublayer ? Promise.resolve(new TextDecoder().decode(bytes)) : isImage(uri) ? imageTexture(bytes, uri) : Promise.resolve().then(() => meshGeometry(uri, bytes))) as Promise<THREE.BufferGeometry | THREE.Texture | string>
        const names = new Set([nameKey(namespace, uri)])
        if (sha256) {
            this.#decoded.set(sha256, decoded)
            this.#waiting.get(sha256)?.forEach((name) => names.add(name))
            this.#waiting.delete(sha256)
            // one that won't decode is decoded again from the next copy
            decoded.catch(() => this.#decoded.delete(sha256))
        }
        for (const name of names) {
            const waiter = splitName(name)
            this.#attach(waiter.namespace, waiter.uri, decoded)
        }
    }

    /** whether `uri` is a layer the module's USD (or one of its sublayers) names in its subLayers */
    #sublayerOf(module: HardwareModule, uri: string): boolean {
        const parser = usdParser()
        return [module.source, ...module.layers.values()].some((layer) => parser?.usdaSublayers?.(layer).includes(uri))
    }

    #attach(namespace: string, uri: string, decoded: Promise<THREE.BufferGeometry | THREE.Texture | string>) {
        const module = this.state.get().modules.get(namespace)
        if (!module || !this.#isWanted(namespace, uri)) {
            return
        }
        decoded.then((value) => {
            if (this.state.get().modules.get(namespace) !== module) {
                return
            }
            if (typeof value === "string") {
                // a sublayer: the USD is read again with it composed in
                module.layers.set(uri, value)
                const parser = usdParser()
                if (parser) {
                    this.#describe(module, parser)
                }
                return
            } else if (isImage(uri)) {
                module.textures.set(uri, value as THREE.Texture)
            } else {
                module.geometries.set(uri, value as THREE.BufferGeometry)
                // a mesh layer's images, named against the layer's own uri and so relative to the module too
                for (const image of meshTextures(value as THREE.BufferGeometry)) {
                    if (!module.files.includes(image)) {
                        module.files.push(image)
                        this.#wantAsset(module, image, null)
                    }
                }
            }
            this.#changed()
        }, (error) => {
            if (this.state.get().modules.get(namespace) === module) {
                module.problem = `${uri}: ${error}`
                this.#changed()
            }
        })
    }

    #setModule(module: HardwareModule) {
        const modules = new Map(this.state.get().modules)
        modules.set(module.namespace, module)
        // its prims are the hardware frames tf's edges are classified by (core/tf.ts): none until its USD is read
        const graph = this.tf as Partial<Pick<TfGraph, "setHardware">>
        graph.setHardware?.(module.namespace, module.frames.length ? module.frames : null)
        this.state.set({ modules, version: this.state.get().version + 1 })
    }

    #changed() {
        this.state.update({ version: this.state.get().version + 1 })
    }
}

/** true unless the bytes' sha256 is known to differ from the one they came with (a copy under the wrong hash would be drawn for every later load) */
async function verified(sha256: string, bytes: Uint8Array): Promise<boolean> {
    const [algorithm, hex] = sha256.split(":")
    if (algorithm !== "sha256" || !hex || !globalThis.crypto?.subtle) {
        return true
    }
    const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer)
    const got = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
    if (got !== hex) {
        meshLog(`a hardware file isn't what its hash says (sha256 ${got.slice(0, 12)}…, not ${hex.slice(0, 12)}…): drawn, not cached`)
    }
    return got === hex
}

const sources = new WeakMap<Connection, HardwareSource>()

/** The page's one HardwareSource for its connection. */
export function hardwareSource(connection: Connection, tf: TfTree): HardwareSource {
    let source = sources.get(connection)
    if (!source) {
        source = new HardwareSource(connection, tf)
        sources.set(connection, source)
    }
    return source
}
