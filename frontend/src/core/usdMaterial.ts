// A description's surface (its UsdPreviewSurface, as dimos-react reads it) as a three material, and its images hung on.
import * as THREE from "three"
import type { DescriptionGeometry, DescriptionTexture } from "dimos-react/three"

/** What a material is made from: a visual's own surface, or a mesh layer's look for one of its groups. */
export type Surface = Pick<
    DescriptionGeometry,
    "roughness" | "metallic" | "ior" | "emissive" | "opacityThreshold" | "clearcoat" | "clearcoatRoughness" | "doubleSided" | "textures"
> & { vertexColors?: boolean }

type Slot = keyof NonNullable<DescriptionGeometry["textures"]>

/** the three map each UsdPreviewSurface input's image goes on, and the channel three reads of it */
const SLOTS: Record<Slot, { map: string; reads: string; chunk?: [include: string, read: string]; colour: boolean }> = {
    diffuse: { map: "map", reads: "rgb", colour: true },
    emissive: { map: "emissiveMap", reads: "rgb", colour: true },
    normal: { map: "normalMap", reads: "rgb", colour: false },
    occlusion: { map: "aoMap", reads: "r", chunk: ["aomap_fragment", "texture2D( aoMap, vAoMapUv ).r"], colour: false },
    roughness: { map: "roughnessMap", reads: "g", chunk: ["roughnessmap_fragment", "texelRoughness.g"], colour: false },
    metallic: { map: "metalnessMap", reads: "b", chunk: ["metalnessmap_fragment", "texelMetalness.b"], colour: false },
    opacity: { map: "alphaMap", reads: "g", chunk: ["alphamap_fragment", "texture2D( alphaMap, vAlphaMapUv ).g"], colour: false },
    clearcoat: { map: "clearcoatMap", reads: "r", chunk: ["lights_physical_fragment", "texture2D( clearcoatMap, vClearcoatMapUv ).x"], colour: false },
    clearcoatRoughness: {
        map: "clearcoatRoughnessMap",
        reads: "g",
        chunk: ["lights_physical_fragment", "texture2D( clearcoatRoughnessMap, vClearcoatRoughnessMapUv ).y"],
        colour: false,
    },
}

const WRAP: Record<DescriptionTexture["wrapS"], THREE.Wrapping> = {
    repeat: THREE.RepeatWrapping,
    mirror: THREE.MirroredRepeatWrapping,
    clamp: THREE.ClampToEdgeWrapping,
    // WebGL has no border colour: outside the image is its edge, not black
    black: THREE.ClampToEdgeWrapping,
}

/** A material for a surface in `color` at `alpha`: its finish, glow, cut-out, clearcoat and sidedness as authored. */
export function surfaceMaterial(color: THREE.ColorRepresentation, alpha: number, surface: Surface = {}): THREE.MeshStandardMaterial {
    const cutOut = (surface.opacityThreshold ?? 0) > 0
    const options: THREE.MeshStandardMaterialParameters = {
        color,
        roughness: surface.roughness ?? 0.55,
        metalness: surface.metallic ?? 0.1,
        // a cut-out is opaque where it is drawn: opacity decides only whether it is
        transparent: !cutOut && alpha < 1,
        opacity: alpha,
        depthWrite: cutOut || alpha >= 1,
        ...(cutOut ? { alphaTest: surface.opacityThreshold } : {}),
        ...(surface.doubleSided ? { side: THREE.DoubleSide } : {}),
        ...(surface.vertexColors ? { vertexColors: true } : {}),
        ...(surface.emissive ? { emissive: new THREE.Color(...surface.emissive) } : {}),
    }
    // an authored ior sets the reflection, Blender's way: ior 1 reflects nothing, even at grazing angles
    const physical = surface.ior !== undefined || (surface.clearcoat ?? 0) > 0
    if (!physical) {
        return new THREE.MeshStandardMaterial(options)
    }
    const ior = surface.ior ?? 1.5
    return new THREE.MeshPhysicalMaterial({
        ...options,
        ior: Math.max(1, ior),
        specularIntensity: ior > 1 ? 1 : 0,
        ...(surface.clearcoat ? { clearcoat: surface.clearcoat, clearcoatRoughness: surface.clearcoatRoughness ?? 0.01 } : {}),
    })
}

/** Every image a surface reads. */
export function surfaceImages(surface: Surface): string[] {
    return Object.values(surface.textures ?? {}).map((texture) => texture?.file).filter((file): file is string => !!file)
}

/** Hangs a clone of each image a surface reads on its material (its wrap, colour space, st placement and channel); true once all are in. */
export function hangImages(material: THREE.MeshStandardMaterial, surface: Surface, files: ReadonlyMap<string, THREE.Texture>, tile?: { span: [number, number]; metres: number }): boolean {
    const textures = Object.entries(surface.textures ?? {}) as [Slot, DescriptionTexture][]
    if (!textures.every(([, texture]) => files.has(texture.file))) {
        return false
    }
    const swizzles: [include: string, from: string, to: string][] = []
    for (const [slot, texture] of textures) {
        const into = SLOTS[slot]
        if (!(into.map in material)) {
            continue
        }
        const map = files.get(texture.file)!.clone()
        map.wrapS = WRAP[texture.wrapS]
        map.wrapT = WRAP[texture.wrapT]
        // auto: a colour is sRGB, a value (roughness, a normal) is read as it is stored
        const srgb = texture.colorSpace === "sRGB" || (texture.colorSpace === "auto" && into.colour && map.colorSpace !== THREE.LinearSRGBColorSpace)
        map.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
        if (texture.transform) {
            // UsdTransform2d: st * scale, turned by rotation, then moved; three's own uv transform turns after it scales
            const { scale, rotation, translation } = texture.transform
            const cos = Math.cos((rotation * Math.PI) / 180)
            const sin = Math.sin((rotation * Math.PI) / 180)
            map.matrixAutoUpdate = false
            map.matrix.set(cos * scale[0], -sin * scale[1], translation[0], sin * scale[0], cos * scale[1], translation[1], 0, 0, 1)
        } else if (tile) {
            map.repeat.set(Math.max(1, tile.span[0] / tile.metres), Math.max(1, tile.span[1] / tile.metres))
        }
        map.needsUpdate = true
        ;(material as unknown as Record<string, THREE.Texture>)[into.map] = map
        const channel = texture.channel.length === 1 ? texture.channel : into.reads
        if (into.chunk && channel !== into.reads) {
            const [include, read] = into.chunk
            swizzles.push([include, read, `${read.slice(0, read.lastIndexOf(".") + 1)}${{ r: "x", g: "y", b: "z", a: "w" }[channel as "r"]}`])
        }
        if (slot === "normal" && texture.scale) {
            // USD's normal is texel * scale + bias, three's texel * 2 - 1: the ratio of the two scales is three's normalScale
            ;(material as THREE.MeshStandardMaterial).normalScale.set(texture.scale[0] / 2, texture.scale[1] / 2)
        }
    }
    if (swizzles.length) {
        material.onBeforeCompile = (shader) => {
            // the chunk is spelled out in place, then read from the channel USD names
            for (const [include, from, to] of swizzles) {
                const chunk = (THREE.ShaderChunk as Record<string, string>)[include]
                shader.fragmentShader = shader.fragmentShader.replace(`#include <${include}>`, chunk).replaceAll(from, to)
            }
        }
        material.customProgramCacheKey = () => swizzles.map(([, , to]) => to).join("|")
    }
    material.needsUpdate = true
    return true
}
