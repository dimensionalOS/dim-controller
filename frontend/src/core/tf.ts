// The transform graph from tf / tf_static, as dimos now has it: an edge per (parent, child) pair, a frame may have
// several parents (its hardware parent from a module's USD and an estimate such as odom → base), and between two
// frames there is one path, found by search rather than by walking one parent per child. An edge is "hardware" when
// both of its frames are prims of a HardwareModule's hardware.usda (setHardware); everything else is "imaginary"
// (estimates). No naming rule decides it. The graph is shown, and handed to anything that wants one parent per frame,
// as a tree rooted at the nav root (the imaginary root: world, map, odom ...) or at the hardware root (the top prim of
// the hardware), per `root`. It extends dimos-react's TfTree so the Viewer and every layer take it as they are.
import { Matrix4, Quaternion, Vector3 } from "three"
import { STALE_MS, type TfSnapshot, type TfSnapshotEdge, TfTree, WORLD_NAMES } from "dimos-react/three"

export { STALE_MS, WORLD_NAMES } from "dimos-react/three"

/** How far back (ms) each dynamic edge keeps its stamped samples for lookupAt. */
export const TF_HISTORY_MS = 5000

/** Which root the graph is shown from: the estimates' (nav) root or the hardware's. */
export type TfRoot = "nav" | "hardware"
export type TfEdgeKind = "hardware" | "imaginary"

export interface TfGraphEdge extends TfSnapshotEdge {
    kind: TfEdgeKind
    /** published the other way round: in the rooted tree its child is the published parent */
    flipped: boolean
}

export interface TfGraphSnapshot extends TfSnapshot {
    /** the rooted tree's edges, one parent per child */
    edges: TfGraphEdge[]
    /** published edges the rooted tree leaves out: each closes a second path between two frames */
    offTree: TfGraphEdge[]
    root: TfRoot
}

interface Sample {
    stamp: number
    translation: Vector3
    rotation: Quaternion
}

interface Edge {
    parent: string
    child: string
    /** T_parent_child, latest */
    matrix: Matrix4
    isStatic: boolean
    receivedAt: number
    /** stamped samples, oldest first, within historyMs of the newest (dynamic edges only) */
    samples: Sample[]
}

/** One step of a path: the edge, and whether it is walked child → parent (inverted). */
interface Step {
    edge: Edge
    inverse: boolean
}

/** A frame's place in a rooted tree: the edge to its tree parent (null at a root). */
interface TreeNode {
    parent: string | null
    edge: Edge | null
    /** the edge is walked against its published direction */
    flipped: boolean
}

const unitScale = new Vector3(1, 1, 1)
const clock = () => globalThis.performance?.now() ?? Date.now()
const pairKey = (parent: string, child: string) => `${parent}\n${child}`

export class TfGraph extends TfTree {
    #edges = new Map<string, Edge>()
    #adjacent = new Map<string, Set<Edge>>()
    /** namespace → the frames its hardware.usda's prims are */
    #hardware = new Map<string, Set<string>>()
    #hardwareFrames = new Set<string>()
    #listeners = new Set<(version: number) => void>()
    #root: TfRoot = "nav"
    /** rooted trees by the frame they hang from, rebuilt after a change */
    #trees = new Map<string, Map<string, TreeNode>>()
    #forest: { roots: string[]; nodes: Map<string, TreeNode> } | null = null
    #cache = new Map<string, Matrix4 | null>()
    #cacheFixed = ""

    constructor({ now = clock, historyMs = TF_HISTORY_MS }: { now?: () => number; historyMs?: number } = {}) {
        super({ now, historyMs })
    }

    /** Sets T_parent_child; `stamp` (ms, the data's clock) keeps a sample for lookupAt. */
    override set(
        parent: string,
        child: string,
        translation: [number, number, number],
        rotation: [number, number, number, number],
        isStatic: boolean = false,
        stamp?: number,
    ) {
        if (!parent || !child || parent === child) {
            return
        }
        const key = pairKey(parent, child)
        let edge = this.#edges.get(key)
        const added = !edge
        if (!edge) {
            edge = { parent, child, matrix: new Matrix4(), isStatic, receivedAt: 0, samples: [] }
            this.#edges.set(key, edge)
            this.#link(parent, edge)
            this.#link(child, edge)
        }
        edge.isStatic ||= isStatic
        edge.receivedAt = this.now()
        const position = new Vector3(...translation)
        const quaternion = new Quaternion(...rotation)
        if (quaternion.lengthSq() < 1e-12) {
            quaternion.set(0, 0, 0, 1)
        }
        quaternion.normalize()
        edge.matrix.compose(position, quaternion, unitScale)
        if (stamp !== undefined && !edge.isStatic) {
            recordSample(edge.samples, stamp, position, quaternion, this.historyMs)
        }
        this.#changed(added)
    }

    #link(frame: string, edge: Edge) {
        let edges = this.#adjacent.get(frame)
        if (!edges) {
            edges = new Set()
            this.#adjacent.set(frame, edges)
        }
        edges.add(edge)
    }

    override clear() {
        this.#edges.clear()
        this.#adjacent.clear()
        this.#changed(true)
    }

    /** `shape`: an edge came or went, or what is hardware or the root changed (the rooted trees are rebuilt) */
    #changed(shape: boolean) {
        this.#cache.clear()
        if (shape) {
            this.#trees.clear()
            this.#forest = null
        }
        this.version++
        for (const listener of [...this.#listeners]) {
            listener(this.version)
        }
    }

    override onChange(listener: (version: number) => void): () => void {
        this.#listeners.add(listener)
        return () => this.#listeners.delete(listener)
    }

    /** The frames a module's hardware.usda names (its prim paths, tf's spelling); null forgets the module. */
    setHardware(namespace: string, frames: Iterable<string> | null) {
        if (frames) {
            this.#hardware.set(namespace, new Set(frames))
        } else if (!this.#hardware.delete(namespace)) {
            return
        }
        this.#hardwareFrames = new Set([...this.#hardware.values()].flatMap((each) => [...each]))
        this.#changed(true)
    }

    /** Whether `frame` is a prim of some module's hardware.usda. */
    isHardwareFrame(frame: string): boolean {
        return this.#hardwareFrames.has(frame)
    }

    /** Whether some HardwareModule's USD has a frame called `name`, under any namespace (`main/base_link` for base_link). */
    hasHardwareFrameNamed(name: string): boolean {
        return this.#hardwareFrames.has(name) || [...this.#hardwareFrames].some((frame) => frame.endsWith(`/${name}`))
    }

    /** hardware when both of its frames are prims of provided hardware.usda files, else imaginary (an estimate) */
    kindOf(parent: string, child: string): TfEdgeKind {
        return this.#hardwareFrames.has(parent) && this.#hardwareFrames.has(child) ? "hardware" : "imaginary"
    }

    /** Which root the graph is shown from (TF panel's toggle); it decides parentOf, snapshot and defaultFixedFrame. */
    get root(): TfRoot {
        return this.#root
    }

    set root(root: TfRoot) {
        if (root !== this.#root) {
            this.#root = root
            this.#changed(true)
        }
    }

    override has(frame: string): boolean {
        return this.#adjacent.has(frame)
    }

    /** `name` as tf has it: itself, else the one frame that is it under a namespace (`main/base_link` for base_link); null when neither */
    resolve(name: string): string | null {
        if (!name || this.#adjacent.has(name)) {
            return name || null
        }
        const namespaced = [...this.#adjacent.keys()].filter((frame) => frame.endsWith(`/${name}`))
        return namespaced.length === 1 ? namespaced[0] : null
    }

    /** The parent of `frame` in the tree rooted as `root` says, or null for a root / unknown frame. */
    override parentOf(frame: string): string | null {
        return this.#rooted().nodes.get(frame)?.parent ?? null
    }

    override frames(): string[] {
        return [...this.#adjacent.keys()].sort()
    }

    /** Every published edge, as published. */
    edges(): { parent: string; child: string; isStatic: boolean; kind: TfEdgeKind }[] {
        return [...this.#edges.values()].map(({ parent, child, isStatic }) => ({ parent, child, isStatic, kind: this.kindOf(parent, child) }))
    }

    /** Each connected group of frames, sorted, biggest first. */
    #components(): string[][] {
        const seen = new Set<string>()
        const groups: string[][] = []
        for (const start of this.frames()) {
            if (seen.has(start)) {
                continue
            }
            const group: string[] = []
            const queue = [start]
            seen.add(start)
            while (queue.length) {
                const frame = queue.shift()!
                group.push(frame)
                for (const edge of this.#adjacent.get(frame) ?? []) {
                    const other = edge.parent === frame ? edge.child : edge.parent
                    if (!seen.has(other)) {
                        seen.add(other)
                        queue.push(other)
                    }
                }
            }
            groups.push(group.sort())
        }
        return groups.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]))
    }

    /** Frames no edge (of `kind`, or any) names as a child, among `frames`. */
    #unparented(frames: string[], kind?: TfEdgeKind): string[] {
        return frames.filter((frame) => ![...this.#adjacent.get(frame) ?? []].some((edge) => edge.child === frame && (!kind || this.kindOf(edge.parent, edge.child) === kind)))
    }

    /** The nav root of a group of frames: a world-ish frame, else one nothing is published under, else its first. */
    #navRootOf(frames: string[]): string {
        return WORLD_NAMES.find((name) => frames.includes(name)) ?? this.#unparented(frames)[0] ?? frames[0]
    }

    /** The hardware root of a group: the hardware frame no hardware edge is a child of with the most hardware under it; null without hardware. */
    #hardwareRootOf(frames: string[]): string | null {
        const hardware = frames.filter((frame) => this.#hardwareFrames.has(frame))
        let best: string | null = null
        let bestSize = -1
        for (const candidate of this.#unparented(hardware, "hardware")) {
            const size = this.#reach(candidate, "hardware")
            if (size > bestSize) {
                best = candidate
                bestSize = size
            }
        }
        return best
    }

    /** How many frames `from` reaches through edges of `kind` walked parent → child. */
    #reach(from: string, kind: TfEdgeKind): number {
        const seen = new Set([from])
        const queue = [from]
        while (queue.length) {
            const frame = queue.shift()!
            for (const edge of this.#adjacent.get(frame) ?? []) {
                if (edge.parent === frame && !seen.has(edge.child) && this.kindOf(edge.parent, edge.child) === kind) {
                    seen.add(edge.child)
                    queue.push(edge.child)
                }
            }
        }
        return seen.size
    }

    /** The nav root (or, as `root` says, the hardware root) of each group, the biggest group's first. */
    roots(root: TfRoot = this.#root): string[] {
        return this.#components().map((frames) => (root === "hardware" ? this.#hardwareRootOf(frames) : null) ?? this.#navRootOf(frames))
    }

    /** The hardware root of the biggest group with hardware in it, else null. */
    hardwareRoot(): string | null {
        for (const frames of this.#components()) {
            const root = this.#hardwareRootOf(frames)
            if (root) {
                return root
            }
        }
        return null
    }

    /** The nav root of the biggest group. */
    navRoot(): string {
        return this.roots("nav")[0] ?? "world"
    }

    /**
     * The tree hanging from `root`: every frame it reaches, with the edge to its parent, by a breadth-first search, so
     * each frame's path to the root is a shortest one. Static and hardware edges are walked before estimates at the
     * same depth (a frame on the robot is placed through its USD, not through a second estimate of it).
     */
    treeFrom(root: string): Map<string, TreeNode> {
        const cached = this.#trees.get(root)
        if (cached) {
            return cached
        }
        const nodes = new Map<string, TreeNode>([[root, { parent: null, edge: null, flipped: false }]])
        let level = [root]
        while (level.length) {
            // each frame one step further takes the best-ranked edge any frame of this level offers it
            const offers = new Map<string, TreeNode>()
            for (const frame of level) {
                for (const edge of this.#adjacent.get(frame) ?? []) {
                    const flipped = edge.child === frame
                    const other = flipped ? edge.parent : edge.child
                    const offered = offers.get(other)?.edge
                    if (!nodes.has(other) && (!offered || this.#rank(edge) < this.#rank(offered) || (this.#rank(edge) === this.#rank(offered) && pairKey(edge.parent, edge.child) < pairKey(offered.parent, offered.child)))) {
                        offers.set(other, { parent: frame, edge, flipped })
                    }
                }
            }
            offers.forEach((node, frame) => nodes.set(frame, node))
            level = [...offers.keys()]
        }
        this.#trees.set(root, nodes)
        return nodes
    }

    #rank(edge: Edge): number {
        return (this.kindOf(edge.parent, edge.child) === "hardware" ? 0 : 2) + (edge.isStatic ? 0 : 1)
    }

    /** The whole graph as a forest: each group hung from its root. */
    #rooted(): { roots: string[]; nodes: Map<string, TreeNode> } {
        if (!this.#forest) {
            const roots = this.roots()
            const nodes = new Map<string, TreeNode>()
            for (const root of roots) {
                for (const [frame, node] of this.treeFrom(root)) {
                    nodes.set(frame, node)
                }
            }
            this.#forest = { roots, nodes }
        }
        return this.#forest
    }

    /** The edges from `frame` up to `root` in the tree hanging from `root`, or null when they aren't connected. */
    #path(frame: string, root: string): Step[] | null {
        const tree = this.treeFrom(root)
        if (!tree.has(frame)) {
            return null
        }
        const steps: Step[] = []
        for (let at = frame; at !== root;) {
            const node = tree.get(at)!
            // walking from `at` up to its tree parent: T_parent_at is the edge as published unless flipped
            steps.push({ edge: node.edge!, inverse: node.flipped })
            at = node.parent!
        }
        return steps
    }

    /** T_root_frame along `steps` (frame first), each edge's transform given by `at`. */
    #compose(steps: Step[], at: (edge: Edge) => Matrix4): Matrix4 {
        const matrix = new Matrix4()
        for (const step of steps) {
            const each = at(step.edge)
            matrix.premultiply(step.inverse ? each.clone().invert() : each)
        }
        return matrix
    }

    /**
     * T_fixed_frame: places data in `frame` into the fixed frame. An empty frame or the fixed frame itself is identity;
     * null when there is no path. The result is cached: don't mutate it.
     */
    override lookup(frame: string, fixed: string): Matrix4 | null {
        if (fixed !== this.#cacheFixed) {
            this.#cache.clear()
            this.#cacheFixed = fixed
        }
        const cached = this.#cache.get(frame)
        if (cached !== undefined) {
            return cached
        }
        let result: Matrix4 | null = null
        if (frame === fixed || frame === "") {
            result = new Matrix4()
        } else {
            const steps = this.#path(frame, fixed)
            if (steps) {
                result = this.#compose(steps, (edge) => edge.matrix)
            } else if (!this.has(fixed) && WORLD_NAMES.includes(frame) && WORLD_NAMES.includes(fixed) && this.#unparented([frame]).length) {
                // a world-ish name tf doesn't have, asked of another that is a root or unknown (a map in "world" while nothing publishes tf): the same frame
                result = new Matrix4()
            }
        }
        this.#cache.set(frame, result)
        return result
    }

    /** T_fixed_frame as it was at `stamp` (ms), each edge interpolated between its samples; else lookup(). A new matrix. */
    override lookupAt(frame: string, fixed: string, stamp: number | undefined): Matrix4 | null {
        if (stamp !== undefined && frame !== fixed && frame !== "") {
            const steps = this.#path(frame, fixed)
            if (steps) {
                return this.#compose(steps, (edge) => edge.samples.length ? sampleAt(edge.samples, stamp) : edge.matrix)
            }
        }
        return this.lookup(frame, fixed)?.clone() ?? null
    }

    /** Per edge on the path from `frame` to `fixed`: its samples kept and whether `stamp` falls inside them. */
    coverage(frame: string, fixed: string, stamp: number) {
        return (this.#path(frame, fixed) ?? []).filter((step) => step.edge.samples.length).map(({ edge }) => {
            const oldest = edge.samples[0].stamp, newest = edge.samples[edge.samples.length - 1].stamp
            return {
                edge: `${edge.parent}->${edge.child}`,
                samples: edge.samples.length,
                oldestMs: Math.round(oldest),
                newestMs: Math.round(newest),
                aheadOfNewestMs: Math.round(stamp - newest),
                clamped: edge.samples.length < 2 || stamp < oldest || stamp >= newest,
            }
        })
    }

    /** The fixed frame to default to: the biggest group's root (nav or hardware, as `root` says). */
    override defaultFixedFrame(): string {
        if (this.#root === "hardware") {
            const hardware = this.hardwareRoot()
            if (hardware) {
                return hardware
            }
        }
        const roots = this.roots("nav")
        return WORLD_NAMES.find((name) => roots.includes(name)) ?? WORLD_NAMES.find((name) => this.has(name)) ?? roots[0] ?? "world"
    }

    override snapshot(): TfGraphSnapshot {
        const now = this.now()
        const { roots, nodes } = this.#rooted()
        const shown = (edge: Edge, flipped: boolean): TfGraphEdge => ({
            parent: flipped ? edge.child : edge.parent,
            child: flipped ? edge.parent : edge.child,
            isStatic: edge.isStatic,
            ageMs: now - edge.receivedAt,
            kind: this.kindOf(edge.parent, edge.child),
            flipped,
        })
        const onTree = new Set<Edge>()
        const edges: TfGraphEdge[] = []
        for (const node of nodes.values()) {
            if (node.edge) {
                onTree.add(node.edge)
                edges.push(shown(node.edge, node.flipped))
            }
        }
        const offTree = [...this.#edges.values()].filter((edge) => !onTree.has(edge)).map((edge) => shown(edge, false))
        // a second path between two frames: both ends of an edge the tree couldn't use
        const cycle = [...new Set(offTree.flatMap((edge) => [edge.parent, edge.child]))].sort()
        const stale = [...this.#edges.values()].filter((edge) => !edge.isStatic && now - edge.receivedAt > STALE_MS).map((edge) => edge.child)
        return {
            frames: this.frames(),
            edges,
            offTree,
            root: this.#root,
            problems: { doubleParent: [], roots: [...roots].sort(), cycle, stale: [...new Set(stale)].sort() },
        }
    }
}

/** Inserts a sample in stamp order (out-of-order delivery from several publishers) and drops ones past the window. */
function recordSample(samples: Sample[], stamp: number, translation: Vector3, rotation: Quaternion, windowMs: number) {
    let index = samples.length
    while (index > 0 && samples[index - 1].stamp > stamp) {
        index--
    }
    samples.splice(index, 0, { stamp, translation: translation.clone(), rotation: rotation.clone() })
    const cutoff = samples[samples.length - 1].stamp - windowMs
    let drop = 0
    while (drop < samples.length - 1 && samples[drop].stamp < cutoff) {
        drop++
    }
    if (drop) {
        samples.splice(0, drop)
    }
}

/** One edge at `stamp`: lerp + slerp between the samples around it, else the newest (debugHook's coverage says which). A new matrix. */
function sampleAt(samples: Sample[], stamp: number): Matrix4 {
    const out = new Matrix4()
    const newest = samples[samples.length - 1]
    if (samples.length < 2 || stamp < samples[0].stamp || stamp >= newest.stamp) {
        return out.compose(newest.translation, newest.rotation, unitScale)
    }
    let low = 0, high = samples.length - 1 // samples[low].stamp <= stamp < samples[high].stamp
    while (high - low > 1) {
        const middle = (low + high) >> 1
        if (samples[middle].stamp <= stamp) {
            low = middle
        } else {
            high = middle
        }
    }
    const before = samples[low], after = samples[high]
    const fraction = (stamp - before.stamp) / (after.stamp - before.stamp)
    return out.compose(before.translation.clone().lerp(after.translation, fraction), before.rotation.clone().slerp(after.rotation, fraction), unitScale)
}

/** The frame the 3D view follows: the picked one as tf has it, else the robot's (a pick tf doesn't have, as another robot's front_camera, isn't waited on forever). */
export function followedFrame(picked: string, robotFrame: string, tf: Pick<TfGraph, "resolve">): string {
    return (picked && tf.resolve(picked)) || robotFrame
}
