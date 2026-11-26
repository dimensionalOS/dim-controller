// An image a USD material names, decoded for use as a map.
//
// A material can state a picture as well as a colour (UsdPreviewSurface's UsdUVTexture), and a
// room's slab does: it is concrete, not a flat grey. The file arrives over the same transport the
// meshes do, so all that is left is to turn the bytes into a texture and tile it -- the shapes
// that want one are big flat things, and a single 256-pixel tile stretched over eighteen metres
// of floor is a blur, not a surface.
import * as THREE from "three"
import { EXRLoader } from "three/examples/jsm/loaders/EXRLoader.js"
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js"
/** high dynamic range pictures (a dome's sky, mostly): decoded to float, linear */
const HDR_SUFFIXES = [".hdr", ".exr"]
const IMAGE_SUFFIXES = [".png", ".jpg", ".jpeg", ".webp", ...HDR_SUFFIXES]
/** Whether this file is a picture rather than geometry (the uri may carry a `?hash=`). */
export function isImage(uri: string): boolean {
    const path = uri.split("?")[0].toLowerCase()
    return IMAGE_SUFFIXES.some((suffix) => path.endsWith(suffix))
}

/** Decoded off the main thread where the browser allows it; the fallback keeps older ones working. Wrap and colour space are the material's (core/usdMaterial.ts). */
export async function imageTexture(data: Uint8Array, uri: string): Promise<THREE.Texture> {
    const path = uri.split("?")[0].toLowerCase()
    if (HDR_SUFFIXES.some((suffix) => path.endsWith(suffix))) {
        return hdrTexture(data, uri, path.endsWith(".exr"))
    }
    const blob = new Blob([data as unknown as BlobPart])
    const texture = typeof createImageBitmap === "function"
        ? new THREE.Texture(
            await createImageBitmap(blob, { imageOrientation: "flipY" }),
        )
        : await viaElement(blob)
    texture.name = uri
    texture.colorSpace = THREE.SRGBColorSpace
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping
    texture.anisotropy = 4
    texture.needsUpdate = true
    return texture
}

function viaElement(blob: Blob): Promise<THREE.Texture> {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob)
        const image = new Image()
        image.onload = () => {
            URL.revokeObjectURL(url)
            resolve(new THREE.Texture(image))
        }
        image.onerror = () => {
            URL.revokeObjectURL(url)
            reject(new Error("the image could not be decoded"))
        }
        image.src = url
    })
}

/** A .hdr (Radiance RGBE) or .exr as a float texture in linear light, as three's loaders parse them. */
function hdrTexture(data: Uint8Array, uri: string, exr: boolean): THREE.Texture {
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    const parsed = exr ? new EXRLoader().setDataType(THREE.HalfFloatType).parse(buffer) : new HDRLoader().setDataType(THREE.HalfFloatType).parse(buffer)
    const texture = new THREE.DataTexture(parsed.data as Uint16Array, parsed.width, parsed.height, (parsed as { format?: THREE.PixelFormat }).format ?? THREE.RGBAFormat, parsed.type)
    texture.name = uri
    texture.colorSpace = THREE.LinearSRGBColorSpace
    texture.flipY = exr ? false : true
    texture.minFilter = texture.magFilter = THREE.LinearFilter
    texture.generateMipmaps = false
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping
    texture.needsUpdate = true
    return texture
}
