// Options in this page's own URL, for an app that shows the Controller in an iframe (docs/reference.md, "URL options").
import type { RobotType } from "../profile/types.ts"
import { chosenType } from "./robotType.ts"

export interface UrlOptions {
    /** ?robot=<type>: this page uses that robot type, saved nowhere; null when not given or not a robot type */
    robot: RobotType | null
    /** ?onboarding=off: no first-run message cards, and no "Waiting for lidar data." in the 3D view */
    onboardingOff: boolean
}

/** A query string (`location.search`) → its options. */
export function readUrlOptions(search: string): UrlOptions {
    const params = new URLSearchParams(search)
    return { robot: chosenType(params.get("robot")), onboardingOff: params.get("onboarding") === "off" }
}

/** This page's options (none in unit tests, which have no page). */
export const urlOptions = readUrlOptions(typeof location === "undefined" ? "" : location.search)
