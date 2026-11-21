// The 3D view's ceiling cut: nothing above a height (z in the fixed frame) is drawn, so a room's ceiling can be cut
// away to look in from above. Meshes go through the renderer's clipping plane; point clouds (dimos-react's point
// material, which ignores three's clipping) through their own clip box's top.
import * as THREE from "three"

import type { Viewer } from "dimos-react/three"

const NONE = 1e9
/** the cut's height until one is picked (m): above a person, under most ceilings */
export const DEFAULT_CEILING_Z = 2

/** `maxZ()`: the height to cut above (m), null for no cut. Read every frame. */
export function watchCeiling(viewer: Viewer, maxZ: () => number | null) {
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0)
    let applied: number | null = null
    viewer.onFrame(() => {
        const wanted = maxZ()
        if (wanted === null && applied === null) {
            return
        }
        applied = wanted
        if (viewer.renderer) {
            plane.constant = wanted ?? NONE
            viewer.renderer.clippingPlanes = wanted === null ? [] : [plane]
        }
        // layers come and go, so every frame's points get the current top (a uniform: no recompile)
        viewer.scene.traverse((object) => {
            const material = (object as THREE.Points).material as THREE.ShaderMaterial | undefined
            const top = material?.uniforms?.uClipMax?.value as THREE.Vector3 | undefined
            if (top) {
                top.z = wanted ?? NONE
            }
        })
    })
}
