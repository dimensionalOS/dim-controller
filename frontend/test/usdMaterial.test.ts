// A USD scene's surfaces as the robot model draws them (core/usdMaterial.ts, core/robotDescription.ts): every input the
// material authors, its images placed by their own st and read from the channel USD names, a mesh layer's groups
// each in their own material and colour, and a light or camera on a link placed by that link (core/sceneLighting.ts).
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1"
import * as THREE from "three"
import { Kinematics, meshGeometry, parseUsda, type RobotDescription } from "dimos-react/three"
import { RobotModel } from "../src/core/robotDescription.ts"
import { hangImages, surfaceMaterial } from "../src/core/usdMaterial.ts"
import { isImage } from "../src/core/imageTexture.ts"
import { placed } from "../src/core/sceneLighting.ts"

const image = (name: string) => {
    const texture = new THREE.DataTexture(new Uint8Array(4), 1, 1)
    texture.name = name
    return texture
}

Deno.test("a surface's glow, cut-out, sides and clearcoat are what it authors", () => {
    const glowing = surfaceMaterial("#ffffff", 0.4, { emissive: [1, 0.5, 0], opacityThreshold: 0.5, doubleSided: true })
    assertEquals(glowing.emissive.toArray(), [1, 0.5, 0])
    // a cut-out is opaque where it is drawn
    assertEquals([glowing.alphaTest, glowing.transparent, glowing.side], [0.5, false, THREE.DoubleSide])
    const coated = surfaceMaterial("#ffffff", 1, { clearcoat: 1, clearcoatRoughness: 0.2 })
    assert(coated instanceof THREE.MeshPhysicalMaterial)
    assertEquals([coated.clearcoat, coated.clearcoatRoughness], [1, 0.2])
})

Deno.test("an image is hung as authored: its wrap, colour space, UsdTransform2d and the channel USD reads", () => {
    const material = surfaceMaterial("#ffffff", 1, {})
    const files = new Map([["d.png", image("d")], ["r.png", image("r")]])
    const surface = {
        textures: {
            diffuse: { file: "d.png", channel: "rgb", wrapS: "mirror", wrapT: "clamp", colorSpace: "auto", transform: { scale: [2, 1], rotation: 0, translation: [0.5, 0] } },
            roughness: { file: "r.png", channel: "r", wrapS: "repeat", wrapT: "repeat", colorSpace: "auto" },
        },
    } as const
    assert(hangImages(material, structuredClone(surface) as never, files))
    assertEquals([material.map!.wrapS, material.map!.wrapT], [THREE.MirroredRepeatWrapping, THREE.ClampToEdgeWrapping])
    assertEquals(material.map!.colorSpace, THREE.SRGBColorSpace)
    // a value is read as stored
    assertEquals(material.roughnessMap!.colorSpace, THREE.NoColorSpace)
    // st * 2 across, moved half a tile: the authored placement, not a tile per metre
    assertEquals(material.map!.matrixAutoUpdate, false)
    assertEquals([material.map!.matrix.elements[0], material.map!.matrix.elements[6]], [2, 0.5])
    // three reads roughness from g; this one is in r
    const shader = { fragmentShader: "#include <roughnessmap_fragment>" } as THREE.WebGLProgramParametersWithUniforms
    material.onBeforeCompile(shader, undefined as never)
    assert(shader.fragmentShader.includes("texelRoughness.x") && !shader.fragmentShader.includes("texelRoughness.g"))
})

Deno.test("a textured shape keeps the tint its texture's scale says, rather than white", () => {
    const description: RobotDescription = {
        name: "r",
        base_link: "room",
        base_frame: "room",
        base_pose: { xyz: [0, 0, 0], quat: [0, 0, 0, 1] },
        joint_names: [],
        joints: [],
        links: [{
            name: "room",
            collisions: [],
            visuals: [{ type: "box", origin: { xyz: [0, 0, 0], quat: [0, 0, 0, 1] }, size: [4, 4, 1], color: [0.5, 0.25, 1, 1], textures: { diffuse: { file: "d.png", channel: "rgb", wrapS: "repeat", wrapT: "repeat", colorSpace: "auto" } } }],
        }],
    }
    const model = new RobotModel(new Kinematics(description), new Map(), {}, undefined, new Map([["d.png", image("d")]]))
    const mesh = model.links.get("room")!.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
    assertEquals(mesh.material.color.toArray(), [0.5, 0.25, 1])
    assert(mesh.material.map, "hung")
    // a gprim has no st: laid a repeat per two metres over its four
    assertEquals(mesh.material.map.repeat.toArray(), [2, 2])
})

Deno.test("a mesh layer draws each group in its own material, its corners in their own colours; an inline Mesh, a Capsule and a Cone draw", () => {
    const layer = `#usda 1.0
def Mesh "two"
{
    point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]
    int[] faceVertexCounts = [3, 3]
    int[] faceVertexIndices = [0, 1, 2, 0, 2, 3]
    color3f[] primvars:displayColor = [(1, 0, 0), (0, 1, 0)] (
        interpolation = "uniform"
    )
}
`
    const geometry = meshGeometry("two.usda", new TextEncoder().encode(layer))
    const description = parseUsda(`#usda 1.0
(
    defaultPrim = "room"
)
def Xform "room"
{
    def Xform "file" (
        prepend references = @two.usda@
    )
    {
    }
    def Mesh "inline"
    {
        point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 1, 0)]
        int[] faceVertexCounts = [3]
        int[] faceVertexIndices = [0, 1, 2]
    }
    def Capsule "capsule"
    {
    }
    def Cone "cone"
    {
    }
}
`)
    const model = new RobotModel(new Kinematics(description), new Map([["two.usda", geometry]]))
    const meshes = model.links.get("room")!.children as THREE.Mesh[]
    assertEquals(meshes.length, 4)
    const file = meshes.find((mesh) => mesh.geometry === geometry)!
    const material = [file.material].flat()[0] as THREE.MeshStandardMaterial
    // the colour is in the corners: the material is white and reads them
    assertEquals([material.vertexColors, material.color.getHex()], [true, 0xffffff])
    assert(meshes.some((mesh) => mesh.geometry instanceof THREE.CapsuleGeometry))
    assert(meshes.some((mesh) => mesh.geometry instanceof THREE.ConeGeometry))
})

Deno.test("a light on a link is placed by that link's pose; an HDR picture is an image", () => {
    const poses = new Map([["lamp", new THREE.Matrix4().makeTranslation(5, 0, 0)], ["room", new THREE.Matrix4()]])
    const light = placed({ xyz: [0, 0, 3], quat: [0, 0, 0, 1], direction: [0, 0, -1], link: "lamp", origin: { xyz: [0, 0, 1], quat: [0, 0, 0, 1] } }, poses, "room")
    assertEquals(light.xyz, [5, 0, 1])
    assertAlmostEquals(light.direction![2], -1)
    assert(isImage("sky/dome.hdr") && isImage("sky/dome.exr?hash=1"))
})
