// Which layer lights the 3D view: a scene's own lights and look (USD lights, RenderSettings' dimos:look:*) are claimed by
// the layer drawing it (the URDF layer's world, the Hardware layer's modules); the newest claim is shown, and a released
// one puts the claim before it back, or the viewer's own lights once none is left.
import * as THREE from "three"
import type { Viewer } from "dimos-react/three"
import type { RobotDescription } from "./robotDescription.ts"

export interface SceneLighting {
    lights?: RobotDescription["lights"]
    look?: RobotDescription["look"]
    /** a dome light's picture, by the path its light names */
    textures?: ReadonlyMap<string, THREE.Texture>
}

const claims = new WeakMap<Viewer, Map<object, SceneLighting>>()

function show(viewer: Viewer) {
    // a claim naming no light and no look (a plain URDF) says nothing, so it never hides one that does
    const newest = [...(claims.get(viewer)?.values() ?? [])].filter((claim) => claim.lights?.length || claim.look).pop()
    viewer.setSceneLights?.(newest?.lights?.length ? newest.lights : null, newest?.textures)
    viewer.setSceneLook?.(newest?.look ?? null)
}

/** `owner` lights the view as `lighting` says (a claim made again moves to the front) */
export function claimSceneLighting(viewer: Viewer, owner: object, lighting: SceneLighting) {
    const mine = claims.get(viewer) ?? new Map<object, SceneLighting>()
    claims.set(viewer, mine)
    mine.delete(owner)
    mine.set(owner, lighting)
    show(viewer)
}

export function releaseSceneLighting(viewer: Viewer, owner: object) {
    if (claims.get(viewer)?.delete(owner)) {
        show(viewer)
    }
}

type Light = NonNullable<SceneLighting["lights"]>[number]

/** A light (or camera) into the fixed frame: on the link it is under, through that link's pose and its place on it; one on no link, through the root's (a USD's root prim sits at its origin). */
export function placed<T extends Pick<Light, "xyz" | "quat" | "link" | "origin"> & { direction?: Light["direction"] }>(item: T, poses: ReadonlyMap<string, THREE.Matrix4>, root: string): T {
    const link = item.link !== undefined ? poses.get(item.link) : undefined
    const local = link && item.origin ? item.origin : { xyz: item.xyz, quat: item.quat ?? [0, 0, 0, 1] }
    const frame = link ?? poses.get(root) ?? new THREE.Matrix4()
    const pose = frame.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3(...local.xyz), new THREE.Quaternion(...local.quat), new THREE.Vector3(1, 1, 1)))
    const position = new THREE.Vector3()
    const quat = new THREE.Quaternion()
    pose.decompose(position, quat, new THREE.Vector3())
    // a light shines down its own -z
    const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(quat)
    return { ...item, xyz: position.toArray(), quat: [quat.x, quat.y, quat.z, quat.w], ...(item.direction ? { direction: direction.toArray() } : {}) }
}
