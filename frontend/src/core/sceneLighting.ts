// Which layer lights the 3D view: a scene's own lights and look (USD lights, RenderSettings' dimos:look:*) are claimed by
// the layer drawing it (the URDF layer's world, the Hardware layer's modules); the newest claim is shown, and a released
// one puts the claim before it back, or the viewer's own lights once none is left.
import type * as THREE from "three"
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
