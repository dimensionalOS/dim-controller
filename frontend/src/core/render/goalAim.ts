// "Go here, facing…" while it aims: an arrow from the goal along the yaw that follows the cursor (where the cursor's ray
// meets the level plane through the goal, in the fixed frame), drawn over everything until the goal is sent or dropped.
import * as THREE from "three"
import { FatLines } from "dimos-react/three"
import type { Viewer } from "dimos-react/three"

/** arrow length (m), head length (m) and line width (CSS px) */
const ARROW_METERS = 1
const HEAD_METERS = 0.3
const ARROW_PX = 6
const COLOR = new THREE.Color(0x3e63dd)

/** The yaw (radians about +z) from `from` toward where the ray through a screen point meets the level plane z = from.z; null when it misses. */
export function yawToward(viewer: Viewer, from: THREE.Vector3, clientX: number, clientY: number): number | null {
    const rect = viewer.canvas.getBoundingClientRect()
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, viewer.camera)
    const hit = raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -from.z), new THREE.Vector3())
    if (!hit || Math.hypot(hit.x - from.x, hit.y - from.y) < 1e-6) {
        return null
    }
    return Math.atan2(hit.y - from.y, hit.x - from.x)
}

export class GoalAim {
    #lines: FatLines

    constructor(readonly viewer: Viewer) {
        this.#lines = new FatLines(viewer.resolution, { width: ARROW_PX, vertexColors: true, capacity: 3 })
        this.#lines.material.depthTest = false
        this.#lines.material.depthWrite = false
        this.#lines.object.renderOrder = 1000
        this.#lines.object.userData.noPick = true
        viewer.scene.add(this.#lines.object)
    }

    /** The arrow at `from` facing `yaw`, or none (null). */
    show(from: THREE.Vector3 | null, yaw = 0) {
        this.#lines.clear()
        if (from) {
            const direction = new THREE.Vector3(Math.cos(yaw), Math.sin(yaw), 0)
            const tip = from.clone().addScaledVector(direction, ARROW_METERS)
            this.#lines.push(from.x, from.y, from.z, tip.x, tip.y, tip.z, COLOR)
            for (const side of [1, -1]) {
                const back = direction.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), side * Math.PI * 0.8)
                const end = tip.clone().addScaledVector(back, HEAD_METERS)
                this.#lines.push(tip.x, tip.y, tip.z, end.x, end.y, end.z, COLOR)
            }
        }
        this.#lines.commit()
        this.viewer.requestRender()
    }

    dispose() {
        this.show(null)
        this.viewer.scene.remove(this.#lines.object)
        this.#lines.dispose()
    }
}
