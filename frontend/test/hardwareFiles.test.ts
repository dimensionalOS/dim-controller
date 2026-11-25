// HardwareSource (core/hardwareFiles.ts) against a fake gateway and fake HardwareModules answering as dimos's do: found from tf frames, no polling,
// conditional requests by sha256, an IndexedDB cache that survives a reload, a mesh two modules share fetched once, an announcement replacing a model
import { assertEquals } from "jsr:@std/assert@1"
import { IDBFactory } from "npm:fake-indexeddb@6.0.0"
import * as THREE from "three"
import { Kinematics, TfTree } from "dimos-react/three"
import { Store } from "../src/core/store.ts"
import type { Connection, ConnectionState } from "../src/core/transport.ts"
import { decodeFileInfo, encodeFileInfo, type FileInfo } from "../src/core/fileInfo.ts"
import { cachedBytes, resetHardwareCache } from "../src/core/hardwareCache.ts"
import { framePrefixes, HARDWARE_RESPONSES, HARDWARE_USD, HardwareSource, moduleFrame, modulePoses, namespaceOfKey, requestKey } from "../src/core/hardwareFiles.ts"

const global = globalThis as { indexedDB?: IDBFactory }

/** a binary STL of one triangle */
function stl(seed = 0): Uint8Array {
    const bytes = new Uint8Array(84 + 50)
    const view = new DataView(bytes.buffer)
    view.setUint32(80, 1, true)
    ;[0, 0, 1, 0, 0, 0, 1 + seed, 0, 0, 0, 1, 0].forEach((value, index) => view.setFloat32(84 + index * 4, value, true))
    return bytes
}

async function sha256(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer)
    return "sha256:" + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** a module's USD as dimos serves it: one arm link with one mesh named relative to the module, hashed in assetInfo */
const usd = (hash: string, mesh = "meshes/arm.stl", note = "") => `#usda 1.0
(
    defaultPrim = "arm"
    metersPerUnit = 1
    upAxis = "Z"
)
${note}
def Xform "arm"
{
    def Xform "base_link" (
        prepend apiSchemas = ["PhysicsRigidBodyAPI"]
    )
    {
        def Mesh "visual_0" (
            assetInfo = {
                asset identifier = @${mesh}@
                string version = "${hash}"
            }
            prepend references = @${mesh}@
        )
        {
        }
    }
}
`

const MESH = stl()
const MESH_HASH = await sha256(MESH)
const ARM = new TextEncoder().encode(usd(MESH_HASH))

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(done: () => boolean) {
    for (let tries = 0; tries < 200 && !done(); tries++) {
        await wait(5)
    }
}
const quietly = async (run: () => Promise<void>) => {
    const info = console.info
    console.info = () => {}
    try {
        await run()
    } finally {
        console.info = info
    }
}

/** one fresh IndexedDB for a test (kept across its reloads), put back after it; null: none at all */
async function withCache(factory: IDBFactory | null, run: () => Promise<void>) {
    if (factory) {
        global.indexedDB = factory
    } else {
        delete global.indexedDB
    }
    resetHardwareCache()
    try {
        await quietly(run)
    } finally {
        await wait(20)
        delete global.indexedDB
        resetHardwareCache()
    }
}

type Files = Map<string, Uint8Array>

/** A gateway with HardwareModules on it: each answers on its own namespace as dimos's HardwareModule does (header only when the asker's hash is current, nothing for a uri it doesn't serve). */
async function bus(modules: Record<string, Files>) {
    const hashes = new Map<Uint8Array, string>()
    for (const files of Object.values(modules)) {
        for (const bytes of files.values()) {
            hashes.set(bytes, await sha256(bytes))
        }
    }
    const requests: { namespace: string; info: FileInfo }[] = []
    let onResponse: ((message: { key: string; bytes: Uint8Array }) => void) | null = null
    const respond = (namespace: string, info: FileInfo) =>
        setTimeout(() => onResponse?.({ key: `dimos/${namespace ? `${namespace}/` : ""}hardware_file_response/files.FileInfo`, bytes: encodeFileInfo(info) }))
    const connection = {
        client: {
            publisher: (key: string) => ({
                put(bytes: Uint8Array) {
                    const namespace = key.replace(/^dimos\/?/, "").replace(/\/?hardware_file_request\/files\.FileInfo$/, "")
                    assertEquals(requestKey(namespace), key)
                    const info = decodeFileInfo(bytes)
                    requests.push({ namespace, info })
                    const file = modules[namespace]?.get(info.uri)
                    if (!file) {
                        return
                    }
                    const sha = hashes.get(file)!
                    respond(namespace, { ts: 1, uri: info.uri, sha256: sha, mtime: 1, ...(info.sha256 === sha ? {} : { content: file }) })
                },
                close() {},
            }),
        },
        status: new Store({ state: "connected" } as ConnectionState),
        subscribe(key: string, _options: unknown, callback: (message: { key: string; bytes: Uint8Array }) => void) {
            assertEquals(key, HARDWARE_RESPONSES)
            onResponse = callback
            return Object.assign(() => {
                onResponse = null
            }, { ready: () => Promise.resolve() })
        },
    } as unknown as Connection
    /** the module restarting with this file changed: its header-only announcement */
    const restart = async (namespace: string, uri: string, bytes: Uint8Array) => {
        modules[namespace].set(uri, bytes)
        hashes.set(bytes, await sha256(bytes))
        respond(namespace, { ts: 2, uri, sha256: hashes.get(bytes), mtime: 2 })
    }
    return { connection, requests, restart }
}

const identity: [number, number, number, number] = [0, 0, 0, 1]
/** a dog and the lidar mounted on it, each a module in its own namespace, as their tf has them */
function robotTf(): TfTree {
    const tf = new TfTree()
    tf.set("world", "go2/base_link", [1, 0, 0], identity)
    tf.set("go2/base_link", "go2/lidar/base_link", [0, 0, 0.3], identity)
    return tf
}

const usdRequests = (requests: { namespace: string; info: FileInfo }[]) => requests.filter((request) => request.info.uri === HARDWARE_USD)
const loaded = (source: HardwareSource, namespace: string) => source.state.get().modules.get(namespace)?.geometries.size ?? 0

Deno.test("pure parts: a response's namespace from its key, a frame's candidate namespaces, a link's frame", () => {
    assertEquals(namespaceOfKey("dimos/go2/lidar/hardware_file_response/files.FileInfo"), "go2/lidar")
    assertEquals(namespaceOfKey("dimos/hardware_file_response/files.FileInfo"), "")
    assertEquals(namespaceOfKey("dimos/go2/file_info/files.File"), null)
    assertEquals(requestKey("go2/lidar"), "dimos/go2/lidar/hardware_file_request/files.FileInfo")
    assertEquals(requestKey(""), "dimos/hardware_file_request/files.FileInfo")
    assertEquals(framePrefixes("a/b/link"), ["a/b", "a", ""])
    assertEquals(framePrefixes("base_link"), [""])
    assertEquals([moduleFrame("go2", "base_link"), moduleFrame("go2", "go2/base_link"), moduleFrame("", "base_link")], ["go2/base_link", "go2/base_link", "base_link"])
})

Deno.test("tf frames find the modules: hardware.usda asked once per namespace, a mesh two modules share fetched once, nothing more without a new frame", async () => {
    await withCache(new IDBFactory(), async () => {
        const { connection, requests } = await bus({ "go2": new Map([[HARDWARE_USD, ARM], ["meshes/arm.stl", MESH]]), "go2/lidar": new Map([[HARDWARE_USD, ARM], ["meshes/arm.stl", MESH]]) })
        const tf = robotTf()
        const source = new HardwareSource(connection, tf)
        const release = source.acquire()
        await until(() => loaded(source, "go2") === 1 && loaded(source, "go2/lidar") === 1)
        assertEquals(usdRequests(requests).map((request) => request.namespace).sort(), ["", "go2", "go2/lidar"], "every prefix of every frame, each once")
        assertEquals(usdRequests(requests).every((request) => request.info.sha256 === undefined && request.info.content === undefined), true, "nothing cached yet: plain header requests")
        assertEquals([...source.state.get().modules.keys()].sort(), ["go2", "go2/lidar"], "the top level never answered, so it has no module")
        assertEquals(source.state.get().modules.get("go2")?.description?.links.map((link) => link.name), ["base_link"])
        const meshRequests = requests.filter((request) => request.info.uri === "meshes/arm.stl")
        assertEquals(meshRequests.length, 1, "one mesh both modules name: asked for once")
        assertEquals(source.state.get().modules.get("go2")?.geometries.get("meshes/arm.stl"), source.state.get().modules.get("go2/lidar")?.geometries.get("meshes/arm.stl"), "and decoded once")
        assertEquals((await cachedBytes(MESH_HASH))?.length, MESH.length, "cached under its sha256")
        const before = requests.length
        tf.set("world", "go2/base_link", [2, 0, 0], identity)
        await wait(20)
        assertEquals(requests.length, before, "tf moving with no new frame asks nothing")
        tf.set("go2/base_link", "go2/foot", [0, 0, -0.3], identity)
        await wait(20)
        assertEquals(usdRequests(requests.slice(before)).map((request) => request.namespace), [""], "a new frame asks only the namespace that never answered")
        release()
    })
})

Deno.test("a reload: the USD asked for with its cached hash, a header-only reply draws it from the cache, no asset fetched", async () => {
    await withCache(new IDBFactory(), async () => {
        const modules = { "go2": new Map([[HARDWARE_USD, ARM], ["meshes/arm.stl", MESH]]) }
        const first = await bus(modules)
        const one = new HardwareSource(first.connection, robotTf())
        const releaseOne = one.acquire()
        await until(() => loaded(one, "go2") === 1)
        releaseOne()
        await wait(20)
        resetHardwareCache()
        const second = await bus(modules)
        const two = new HardwareSource(second.connection, robotTf())
        const releaseTwo = two.acquire()
        await until(() => loaded(two, "go2") === 1)
        const asked = usdRequests(second.requests).find((request) => request.namespace === "go2")!
        assertEquals(asked.info.sha256, await sha256(ARM), "conditional: the hash it has")
        assertEquals(second.requests.filter((request) => request.info.uri !== HARDWARE_USD), [], "the mesh's hash is cached: never asked for")
        assertEquals(loaded(two, "go2"), 1, "drawn from the cache")
        releaseTwo()
    })
})

Deno.test("a start announcement with a new hash replaces what's drawn there; the unchanged mesh comes from the cache", async () => {
    await withCache(new IDBFactory(), async () => {
        const { connection, requests, restart } = await bus({ "go2": new Map([[HARDWARE_USD, ARM], ["meshes/arm.stl", MESH]]) })
        const source = new HardwareSource(connection, robotTf())
        const release = source.acquire()
        await until(() => loaded(source, "go2") === 1)
        const old = source.state.get().modules.get("go2")
        const edited = new TextEncoder().encode(usd(MESH_HASH, "meshes/arm.stl", "# the module restarted with an edited USD"))
        const before = requests.length
        await restart("go2", HARDWARE_USD, edited)
        await until(() => source.state.get().modules.get("go2") !== old && loaded(source, "go2") === 1)
        assertEquals(loaded(source, "go2"), 1, "drawn again")
        const now = source.state.get().modules.get("go2")!
        assertEquals(now.sha256, await sha256(edited), "the announced USD is the one drawn")
        assertEquals(requests.slice(before).map((request) => request.info.uri), [HARDWARE_USD], "only the new USD fetched: the mesh's hash didn't change")
        const sameAgain = source.state.get().modules.get("go2")
        await restart("go2", HARDWARE_USD, edited)
        await wait(20)
        assertEquals(source.state.get().modules.get("go2"), sameAgain, "an announcement of what's drawn changes nothing")
        release()
    })
})

Deno.test("no IndexedDB: everything is fetched and still drawn", async () => {
    await withCache(null, async () => {
        const { connection, requests } = await bus({ "go2": new Map([[HARDWARE_USD, ARM], ["meshes/arm.stl", MESH]]) })
        const source = new HardwareSource(connection, robotTf())
        const release = source.acquire()
        await until(() => loaded(source, "go2") === 1)
        assertEquals(loaded(source, "go2"), 1)
        assertEquals(requests.filter((request) => request.info.uri === "meshes/arm.stl").length, 1)
        release()
    })
})

Deno.test("a file whose bytes aren't the hash it came with is drawn but not cached", async () => {
    await withCache(new IDBFactory(), async () => {
        const wrong = stl(1)
        const { connection } = await bus({ "go2": new Map([[HARDWARE_USD, ARM], ["meshes/arm.stl", wrong]]) })
        // the module claims the USD's hash for the other bytes
        const lying = { ...connection, subscribe: (key: string, options: unknown, callback: (message: { key: string; bytes: Uint8Array }) => void) =>
            connection.subscribe(key, options as never, (message) => {
                const info = decodeFileInfo(message.bytes)
                callback(info.uri === "meshes/arm.stl" ? { ...message, bytes: encodeFileInfo({ ...info, sha256: MESH_HASH }) } : message)
            }) } as unknown as Connection
        const source = new HardwareSource(lying, robotTf())
        const release = source.acquire()
        await until(() => loaded(source, "go2") === 1)
        assertEquals(loaded(source, "go2"), 1, "drawn")
        await wait(20)
        assertEquals(await cachedBytes(MESH_HASH), null, "not kept under a hash it isn't")
        release()
    })
})

Deno.test("the link coming back: what nobody answered is asked again, a drawn module asked conditionally", async () => {
    await withCache(new IDBFactory(), async () => {
        const { connection, requests } = await bus({ "go2": new Map([[HARDWARE_USD, ARM], ["meshes/arm.stl", MESH]]) })
        const source = new HardwareSource(connection, robotTf())
        const release = source.acquire()
        await until(() => loaded(source, "go2") === 1)
        await wait(20)
        const before = requests.length
        connection.status.update({ state: "lost" })
        connection.status.update({ state: "connected" })
        await wait(20)
        const again = usdRequests(requests.slice(before))
        assertEquals(again.map((request) => request.namespace).sort(), ["", "go2", "go2/lidar"], "each once: the two that never answered, and go2 in case it restarted unseen")
        assertEquals(again.find((request) => request.namespace === "go2")?.info.sha256, await sha256(ARM), "go2 conditionally, with the hash it has")
        await wait(20)
        assertEquals(requests.slice(before).filter((request) => request.info.uri !== HARDWARE_USD), [], "an unchanged USD: nothing fetched again")
        release()
    })
})

Deno.test("a module's links placed at its namespace's tf frames, its root by tf", () => {
    const tf = robotTf()
    const kinematics = new Kinematics({ name: "arm", base_link: "base_link", base_frame: "base_link", base_pose: { xyz: [0, 0, 0], quat: [0, 0, 0, 1] }, joint_names: [], joints: [], links: [{ name: "base_link", visuals: [], collisions: [] }] })
    const poses = modulePoses(kinematics, "go2/lidar", (frame) => tf.lookup(frame, "world"))!
    assertEquals(new THREE.Vector3().setFromMatrixPosition(poses.get("base_link")!).toArray(), [1, 0, 0.3], "the lidar's base_link under the dog's")
    assertEquals(modulePoses(kinematics, "spot", (frame) => tf.lookup(frame, "world")), null, "no tf for its root: not placed")
})
