// The USD side of the robot description. dimos's UsdManager answers a request for `*.usd` on /render_file_request with
// its stage as a `.usda` layer, and reading one into the same RobotDescription a URDF gives is dimos-react's job
// (src/three/urdf/usda.ts): everything downstream — the robot model layer, the arm view, IK, mesh loading — never
// learns which one the robot sent.
//
// This module is the one place that touches that parser, because a pinned dimos-react older than it has none of its
// exports: then `usdParser()` is null, nothing asks for `*.usd` at all, a USD reply that turns up anyway is ignored
// with one line in the console, and a robot's URDF is used exactly as before. Bumping the pin (frontend/deno.json,
// then `deno task update-hashes` at the repo root) is the whole of turning USD on.
import * as three from "dimos-react/three"
import type { RobotDescription } from "./robotDescription.ts"
import { meshLog } from "./meshCache.ts"

/** What this app needs of dimos-react's USD parser. */
export interface UsdParser {
    /** a layer this parser can read, by its `#usda` header rather than its name */
    isUsda(text: string): boolean
    /** the layer as the same RobotDescription parseUrdf gives; throws when the text is not a USD layer */
    parseUsda(text: string): RobotDescription
    /** every asset path the layer names, as it authored them (the app reads them off the description instead) */
    usdaMeshUris?(text: string): string[]
    /**
     * Each asset path (as authored) to the content hash the layer identifies it by: USD's own
     * `assetInfo = { string version = "sha256:<hex>" }`. A path the layer leaves unhashed is absent.
     *
     * Not in every dimos-react that has the rest: a parser without it means USD meshes aren't cached.
     */
    usdaAssetHashes?(text: string): Map<string, string>
}

/** the names UsdManager answers with a stage, and so the names a reply carrying one has */
export const USD_SUFFIXES = [".usd", ".usda"] as const
/** what a request for the stage names: UsdManager answers any *.usd with it, named as asked */
export const USD_REQUEST = "*.usd"

/** True for a file name that is a USD layer (dimos only ever sends the text form; .usdc is binary and never travels). */
export function isUsdName(name: string): boolean {
    const base = name.split("?")[0].toLowerCase()
    return USD_SUFFIXES.some((suffix) => base.endsWith(suffix))
}

const fromBundle = three as unknown as Partial<UsdParser>
let parser: UsdParser | null = typeof fromBundle.isUsda === "function" && typeof fromBundle.parseUsda === "function" ? fromBundle as UsdParser : null

/** The USD parser this build has, or null when its dimos-react predates it (then nothing asks for USD). */
export function usdParser(): UsdParser | null {
    return parser
}

/** Puts a parser in place of the bundled one (a test, or a build whose dimos-react has none); null takes USD away. */
export function installUsdParser(replacement: UsdParser | null): UsdParser | null {
    const previous = parser
    parser = replacement
    return previous
}

let saidNoHashes = false

/**
 * Each asset path in the layer to its content hash, for keying the file cache.
 *
 * A layer from somewhere other than dimos may name assets with no `assetInfo` hash: that is not a failure, those
 * files are simply fetched every load (said once, not per mesh). dimos refuses to serve a subtree whose assets are
 * unhashed, so its own layers always carry them.
 */
export function usdAssetHashes(text: string, of: UsdParser): Map<string, string> {
    if (!of.usdaAssetHashes) {
        if (!saidNoHashes) {
            saidNoHashes = true
            meshLog("this dimos-react's USD parser can't read assetInfo hashes: USD meshes are fetched every load, uncached")
        }
        return new Map()
    }
    try {
        return of.usdaAssetHashes(text)
    } catch (error) {
        meshLog("the USD layer's asset hashes couldn't be read, so its meshes aren't cached:", error)
        return new Map()
    }
}

/** The prim tree as dimos-react reads it (parsePrims), when its bundle has it. */
interface PrimNode {
    name: string
    displayName?: string
    meta: Record<string, string>
    children: PrimNode[]
}

const parsePrims = (three as unknown as { parsePrims?: (text: string) => PrimNode[] }).parsePrims

/** Each prim's path in tf's spelling, `/go2/head` → `go2/head` (dimos: every provided prim sits under its module's namespace, so the path is the frame). */
function eachPrim(roots: PrimNode[], visit: (prim: PrimNode, path: string) => void, prefix = "") {
    for (const prim of roots) {
        const path = prefix ? `${prefix}/${prim.name}` : prim.name
        visit(prim, path)
        eachPrim(prim.children, visit, path)
    }
}

/** Every prim path of a layer, as tf frames; empty when this dimos-react can't list prims. */
export function usdPrimPaths(text: string): string[] {
    if (!parsePrims) {
        return []
    }
    const paths: string[] = []
    eachPrim(parsePrims(text), (_, path) => paths.push(path))
    return paths
}

/**
 * The description with its links named by their prim paths rather than their displayName: a HardwareModule's tf frame
 * IS the prim path (dimos/core/hardware_module.py), and a displayName is only a label. dimos-react's parser names a
 * link by its displayName (UsdManager's older dialect, where it held the tf name); this renames each link, and the
 * joints and base that name it, to its path. A name two prims share is the outer one when it holds the other (a link and
 * its own same-named mesh), else left as it is (it can't be told apart).
 */
export function framesFromPrimPaths(description: RobotDescription, text: string): RobotDescription {
    if (!parsePrims) {
        return description
    }
    const pathsByName = new Map<string, Set<string>>()
    eachPrim(parsePrims(text), (prim, path) => {
        const name = prim.displayName ?? prim.name
        pathsByName.set(name, (pathsByName.get(name) ?? new Set()).add(path))
    })
    const rename = (name: string) => {
        const paths = [...pathsByName.get(name) ?? []]
        // a link's mesh named as its link (`…/pelvis/pelvis`) is under it: the outermost prim holding all the others is the link
        const outer = paths.find((path) => paths.every((other) => other === path || other.startsWith(`${path}/`)))
        return outer ?? name
    }
    return {
        ...description,
        base_link: rename(description.base_link),
        base_frame: rename(description.base_frame),
        links: description.links.map((link) => ({ ...link, name: rename(link.name) })),
        joints: description.joints.map((joint) => ({ ...joint, parent: rename(joint.parent), child: rename(joint.child) })),
    }
}
