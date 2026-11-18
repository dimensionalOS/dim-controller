// The 3D view's right-click menu: label the clicked spot (a text label at that point in the fixed frame, written into
// the recording if one runs; with dimos's NamedLocations module running, a named location sent to it) or rename or
// remove the label under the cursor. A right-drag still pans: only a right click that
// barely moved opens it (a long press on touch). "Go here" publishes clicked_point: it sends the spot to the nav stack (one message).
// "Go here, facing…" aims first: an arrow from the spot follows the cursor (a drag on touch), and a click sends the spot and
// that yaw as a PoseStamped on /goal (core/goalPose.ts); Esc or a right click drops it. "Cancel goal" stops the one under way.
import { useEffect, useRef, useState } from "react"
import * as THREE from "three"
import type { ViewerApp } from "../core/app.ts"
import type { LocationLabel } from "../core/labels.ts"
import { recorder } from "../core/recorder.ts"
import { clickedPoint } from "../core/clickedPoint.ts"
import { cancelGoal, goalPose } from "../core/goalPose.ts"
import { GoalAim, yawToward } from "../core/render/goalAim.ts"
import { createRightClickTip, narrate, RIGHT_CLICK_TIP_TEXT } from "../core/rightClickTip.ts"
import { Button, Card, TextInput } from "dimos-react"

interface Menu {
    x: number
    y: number
    point: THREE.Vector3 | null
    on: string
    near: LocationLabel | null
    /** typing a new label's text, or the one under the cursor's new text */
    editing: false | "new" | "rename"
}

const fmt = (value: number) => value.toFixed(2)
const degrees = (yaw: number) => Math.round(THREE.MathUtils.radToDeg(yaw))

export function SceneMenu({ app }: { app: ViewerApp }) {
    const [menu, setMenu] = useState<Menu | null>(null)
    const [text, setText] = useState("")
    const [note, setNote] = useState<string | null>(null)
    /** "Go here, facing…" aiming from this spot */
    const [aiming, setAiming] = useState<{ point: THREE.Vector3; yaw: number } | null>(null)
    const box = useRef<HTMLDivElement>(null)

    useEffect(() => {
        const canvas = app.viewer.canvas
        let down: { x: number; y: number } | null = null
        let leftDown: { x: number; y: number } | null = null
        const tip = createRightClickTip({
            show: () => narrate(RIGHT_CLICK_TIP_TEXT).then((narrated) => !narrated && setNote(RIGHT_CLICK_TIP_TEXT)),
        })
        const open = (x: number, y: number) => {
            tip.rightClicked()
            const picked = app.viewer.pick(x, y)
            setText("")
            setMenu({ x, y, point: picked?.point ?? null, on: picked?.on ?? "", near: app.labels.near(x, y), editing: false })
        }
        const onDown = (event: PointerEvent) => {
            if (event.button === 2 && event.pointerType === "mouse") {
                down = { x: event.clientX, y: event.clientY }
            } else if (event.button === 0) {
                setMenu(null)
                leftDown = event.pointerType === "mouse" ? { x: event.clientX, y: event.clientY } : null
            }
        }
        const onUp = (event: PointerEvent) => {
            // a left click that barely moved (an orbit drag isn't one) counts toward the double-click tip
            if (event.button === 0 && leftDown && Math.hypot(event.clientX - leftDown.x, event.clientY - leftDown.y) < 5) {
                tip.click(event.timeStamp)
            }
            if (event.button === 0) {
                leftDown = null
            }
            if (event.button === 2 && down && Math.hypot(event.clientX - down.x, event.clientY - down.y) < 5) {
                open(event.clientX, event.clientY)
            }
            down = null
        }
        // touch: a long press is a contextmenu event (mice are handled on pointerup, so a right-drag pan isn't one)
        const onContext = (event: MouseEvent) => {
            event.preventDefault()
            if ((event as PointerEvent).pointerType === "touch") {
                open(event.clientX, event.clientY)
            }
        }
        canvas.addEventListener("pointerdown", onDown)
        canvas.addEventListener("pointerup", onUp)
        canvas.addEventListener("contextmenu", onContext)
        return () => {
            canvas.removeEventListener("pointerdown", onDown)
            canvas.removeEventListener("pointerup", onUp)
            canvas.removeEventListener("contextmenu", onContext)
        }
    }, [app])

    useEffect(() => {
        if (!menu) {
            return
        }
        const onKey = (event: KeyboardEvent) => event.key === "Escape" && setMenu(null)
        const onOutside = (event: PointerEvent) => !box.current?.contains(event.target as Node) && setMenu(null)
        addEventListener("keydown", onKey)
        addEventListener("pointerdown", onOutside, true)
        return () => {
            removeEventListener("keydown", onKey)
            removeEventListener("pointerdown", onOutside, true)
        }
    }, [menu])

    useEffect(() => {
        if (!note) {
            return
        }
        const timer = setTimeout(() => setNote(null), 3000)
        return () => clearTimeout(timer)
    }, [note])

    const save = async () => {
        if (!menu || !text.trim()) {
            return
        }
        const { point, near, editing } = menu
        setMenu(null)
        try {
            if (editing === "rename" && near) {
                await app.labels.rename(near, text.trim())
                setNote("Rename sent to NamedLocations")
                return
            }
            if (!point) {
                return
            }
            await app.labels.create(text.trim(), point)
            // the module keeps no store of its own: a name lasts past this run only if it was recorded, and that
            // recording becomes the next run's map file
            setNote(recorder.status.get().recording.active ? "Location sent to NamedLocations" : "Location added (not recording: this session only)")
            recorder.refresh()
        } catch (error) {
            setNote(`Couldn't ${editing === "rename" ? "rename" : "add"} the label: ${error instanceof Error ? error.message : error}`)
        }
    }

    const remove = async (label: LocationLabel) => {
        setMenu(null)
        try {
            await app.labels.remove(label.id)
        } catch (error) {
            setNote(`Couldn't remove the label: ${error instanceof Error ? error.message : error}`)
        }
    }

    /** Puts each message (a command: the drive lease covers it), then notes `done`, or what went wrong with `what`. */
    const publish = async (what: string, messages: { key: string; bytes: Uint8Array }[], done: string) => {
        const client = app.connection.client
        if (!client || client.state === "lost") {
            setNote(`Couldn't ${what}: not connected to the gateway`)
            return
        }
        try {
            for (const { key, bytes } of messages) {
                app.connection.command(key)
                await client.put(key, bytes)
            }
            setNote(done)
        } catch (error) {
            setNote(`Couldn't ${what}: ${error instanceof Error ? error.message : error}`)
        }
    }

    const publishClickedPoint = (point: THREE.Vector3) => {
        setMenu(null)
        const frame = app.viewer.fixedFrame
        publish("publish clicked_point", [clickedPoint(point, frame)], `Published clicked_point ${fmt(point.x)}, ${fmt(point.y)}, ${fmt(point.z)} (${frame})`)
    }

    const sendCancel = () => {
        setMenu(null)
        setAiming(null)
        publish("cancel the goal", cancelGoal(app.viewer.fixedFrame), "Goal cancelled")
    }

    // aiming: the arrow follows the cursor; a press (mouse or touch) aims and is the page's alone (no orbit), its release sends
    useEffect(() => {
        if (!aiming) {
            return
        }
        const { point } = aiming
        const arrow = new GoalAim(app.viewer)
        let yaw = aiming.yaw
        let pressed: number | null = null
        arrow.show(point, yaw)
        const onCanvas = (event: Event) => event.target === app.viewer.canvas
        const aim = (event: PointerEvent) => {
            yaw = yawToward(app.viewer, point, event.clientX, event.clientY) ?? yaw
            arrow.show(point, yaw)
        }
        const onMove = (event: PointerEvent) => {
            if (pressed === null || event.pointerId === pressed) {
                aim(event)
            }
        }
        const onDown = (event: PointerEvent) => {
            if (!onCanvas(event)) {
                return
            }
            event.stopImmediatePropagation()
            event.preventDefault()
            if (event.button === 2) {
                setAiming(null)
                return
            }
            pressed = event.pointerId
            aim(event)
        }
        const onUp = (event: PointerEvent) => {
            if (event.pointerId !== pressed) {
                return
            }
            event.stopImmediatePropagation()
            setAiming(null)
            const frame = app.viewer.fixedFrame
            publish("send the goal", [goalPose(point, yaw, frame)], `Goal sent: ${fmt(point.x)}, ${fmt(point.y)} facing ${degrees(yaw)}° (${frame})`)
        }
        const onKey = (event: KeyboardEvent) => event.key === "Escape" && setAiming(null)
        const onContext = (event: MouseEvent) => onCanvas(event) && event.preventDefault()
        addEventListener("pointermove", onMove, true)
        addEventListener("pointerdown", onDown, true)
        addEventListener("pointerup", onUp, true)
        addEventListener("keydown", onKey)
        addEventListener("contextmenu", onContext, true)
        return () => {
            removeEventListener("pointermove", onMove, true)
            removeEventListener("pointerdown", onDown, true)
            removeEventListener("pointerup", onUp, true)
            removeEventListener("keydown", onKey)
            removeEventListener("contextmenu", onContext, true)
            arrow.dispose()
        }
    }, [aiming, app])

    // keep the menu on screen
    const left = menu ? Math.min(menu.x, innerWidth - 250) : 0
    const top = menu ? Math.min(menu.y, innerHeight - 235) : 0
    return (
        <>
            {menu && (
                <Card ref={box} padded={false} className="scene-menu" data-testid="scene-menu" style={{ left, top }} role="menu" onContextMenu={(event) => event.preventDefault()}>
                    {menu.point && (
                        <div className="scene-menu-where dr-mono">
                            {fmt(menu.point.x)}, {fmt(menu.point.y)}, {fmt(menu.point.z)} · {app.viewer.fixedFrame}
                            {menu.on === "ground" ? " · ground" : ""}
                        </div>
                    )}
                    {menu.editing ? (
                        <form
                            className="scene-menu-edit"
                            onSubmit={(event) => {
                                event.preventDefault()
                                save()
                            }}
                        >
                            <TextInput autoFocus data-testid="scene-menu-text" placeholder="Name this location" value={text} onChange={setText} />
                            <Button type="submit" variant="primary" disabled={!text.trim()} data-testid="scene-menu-save">{menu.editing === "rename" ? "Rename" : "Add"}</Button>
                        </form>
                    ) : (
                        <>
                            <button type="button" role="menuitem" className="scene-menu-item" disabled={!menu.point} onClick={() => publishClickedPoint(menu.point!)} data-testid="scene-menu-go-here">
                                Go here
                            </button>
                            <button type="button" role="menuitem" className="scene-menu-item" disabled={!menu.point} onClick={(event) => {
                                setMenu(null)
                                setAiming({ point: menu.point!, yaw: yawToward(app.viewer, menu.point!, event.clientX, event.clientY) ?? 0 })
                            }} data-testid="scene-menu-go-facing">
                                Go here, facing…
                            </button>
                            <button type="button" role="menuitem" className="scene-menu-item" onClick={sendCancel} data-testid="scene-menu-cancel-goal">
                                Cancel goal
                            </button>
                            <button type="button" role="menuitem" className="scene-menu-item" disabled={!menu.point} onClick={() => setMenu({ ...menu, editing: "new" })} data-testid="scene-menu-label">
                                Label this location…
                            </button>
                            {menu.near && (
                                <>
                                    <button type="button" role="menuitem" className="scene-menu-item" data-testid="scene-menu-rename" onClick={() => {
                                        setText(menu.near!.label)
                                        setMenu({ ...menu, editing: "rename" })
                                    }}>
                                        Rename label “{menu.near.label}”…
                                    </button>
                                    <button type="button" role="menuitem" className="scene-menu-item" data-testid="scene-menu-remove" onClick={() => remove(menu.near!)}>
                                        Remove label “{menu.near.label}”
                                    </button>
                                </>
                            )}
                        </>
                    )}
                </Card>
            )}
            {aiming && <Card padded={false} className="scene-note" data-testid="scene-aim-note">Point the arrow, then click to send · Esc cancels</Card>}
            {!aiming && note && <Card padded={false} className="scene-note" data-testid="scene-note">{note}</Card>}
        </>
    )
}
