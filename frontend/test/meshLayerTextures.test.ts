// A USD mesh layer's textures (core/urdfSource.ts, core/robotDescription.ts): asked for on /render_file_request by the layer's path joined with the image's, decoded, cached, and hung on the layer's materials.
import { assert, assertEquals } from "jsr:@std/assert@1"
import { IDBFactory } from "npm:fake-indexeddb@6.0.0"
import { Store } from "../src/core/store.ts"
import type { Connection, ConnectionState } from "../src/core/transport.ts"
import { resetCacheConnection } from "../src/core/meshCache.ts"
import { decode } from "../src/core/lcm/lcm.ts"
import { FILE_INFO, FILE_REQUEST, UrdfSource } from "../src/core/urdfSource.ts"
import { installUsdParser, type UsdParser } from "../src/core/usd.ts"
import { Kinematics, type RobotDescription, RobotModel } from "../src/core/robotDescription.ts"
import type * as THREE from "three"

const global = globalThis as { indexedDB?: IDBFactory }
/** written by pxr (dimos-react's test/fixtures/textured.usdc): a quad reading ../textures/wood.png, and a red one */
const MESH_LAYER = Deno.readFileSync(new URL("./fixtures/textured.usdc", import.meta.url))
const LAYER_NAME = "/dimos/assets/room/geometry/textured.usdc"
/** the name dimos's world_files.py serves the image under: the naming layer's path joined with the image's own */
const TEXTURE_NAME = "/dimos/assets/room/textures/wood.png"
/** a 2 x 2 PNG */
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGM8kWLEwMDAxAAGABEoAWLadcqhAAAAAElFTkSuQmCC"), (character) => character.charCodeAt(0))
const origin = { xyz: [0, 0, 0] as [number, number, number], quat: [0, 0, 0, 1] as [number, number, number, number] }

/** only enough of a USD parser to name the one mesh layer: the layer itself is read by dimos-react's real reader */
const standIn: UsdParser = {
    isUsda: (text) => /^\s*#usda\s/.test(text),
    parseUsda: (): RobotDescription => ({
        name: "room",
        base_link: "room",
        base_frame: "room",
        base_pose: origin,
        joint_names: [],
        joints: [],
        links: [{ name: "room", visuals: [{ type: "mesh", origin, mesh: LAYER_NAME }], collisions: [] }],
    }),
}

/** files.File's wire form: `<f64 ts><u32 name length><name><file bytes>` */
function fileInfo(uri: string, data: Uint8Array): Uint8Array {
    const name = new TextEncoder().encode(uri)
    const bytes = new Uint8Array(12 + name.length + data.length)
    new DataView(bytes.buffer).setUint32(8, name.length, true)
    bytes.set(name, 12)
    bytes.set(data, 12 + name.length)
    return bytes
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** a page load: a UrdfSource on a fake connection answering `*.usd`, the mesh layer and its image by those names */
async function load() {
    const requests: string[] = []
    const handlers = new Map<string, (message: { bytes: Uint8Array }) => void>()
    const served = new Map([["*.usd", new TextEncoder().encode("#usda 1.0\n")], [LAYER_NAME, MESH_LAYER], [TEXTURE_NAME, PNG]])
    const connection = {
        client: {
            publisher: (key: string) => ({
                put(bytes: Uint8Array) {
                    const asked = String(decode("std_msgs.String", bytes).data)
                    if (key !== FILE_REQUEST) {
                        return
                    }
                    requests.push(asked)
                    const data = served.get(asked)
                    if (data) {
                        setTimeout(() => handlers.get(FILE_INFO)?.({ bytes: fileInfo(asked, data) }))
                    }
                },
                close() {},
            }),
        },
        status: new Store({ state: "connected" } as ConnectionState),
        subscribe(key: string, _options: unknown, onMessage: (message: { bytes: Uint8Array }) => void) {
            handlers.set(key, onMessage)
            return () => handlers.delete(key)
        },
    } as unknown as Connection
    const source = new UrdfSource(connection)
    const release = source.acquire()
    for (let tries = 0; tries < 200 && (source.state.get().meshesLoaded < 2 || source.state.get().meshesWanted < 2); tries++) {
        await wait(20)
    }
    const state = source.state.get()
    release()
    await wait(50)
    return { source, requests: [...new Set(requests)], loaded: state.meshesLoaded, wanted: state.meshesWanted, problem: state.problem }
}

Deno.test("a mesh layer's texture is asked for by the name dimos serves it under, hung on its material, and cached", async () => {
    const info = console.info
    console.info = () => {}
    global.indexedDB = new IDBFactory()
    resetCacheConnection()
    const previous = installUsdParser(standIn)
    try {
        const first = await load()
        assertEquals(first.problem, null)
        assertEquals([first.loaded, first.wanted], [2, 2], "the layer and its image")
        assertEquals(first.requests, ["*.urdf", "*.usd", LAYER_NAME, TEXTURE_NAME])
        const description = first.source.state.get().description!
        const model = new RobotModel(new Kinematics(description), first.source.geometries, {}, undefined, first.source.textures)
        const mesh = model.links.get("room")!.children[0] as THREE.Mesh
        const materials = mesh.material as THREE.MeshStandardMaterial[]
        assertEquals(materials.length, 2, "one material per group")
        assertEquals(materials[0].map, first.source.textures.get(TEXTURE_NAME)!, "the quad's image on its own material")
        assert(materials[1].map === null, "the red quad has none")
        assertEquals([materials[0].color.r, materials[0].color.g], [0.5, 0.25], "multiplied by the texture's scale")
        // a reload: both from the cache, nothing asked for
        resetCacheConnection()
        const second = await load()
        assertEquals([second.loaded, second.wanted], [2, 2])
        assertEquals(second.requests, ["*.urdf", "*.usd"])
    } finally {
        await wait(50)
        delete global.indexedDB
        resetCacheConnection()
        installUsdParser(previous)
        console.info = info
    }
})
