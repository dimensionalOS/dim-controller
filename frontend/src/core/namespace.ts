// The robot namespace (Settings → Namespace; dimos's Blueprint.namespace("robot1"), one per robot when a blueprint runs
// several): a namespaced blueprint's topics are
// `dimos/robot1/<topic>/<type>` and its TF frames `robot1/<frame>` (nested: fleet/robot1). With one picked, the page works as if the namespace
// weren't there: the zenoh client it uses maps every dimos key into the namespace and back (namespacedClient), the
// topic list shows the namespace's topics by their plain names (plus the shared ones no namespace has), and decoded
// messages lose the frames' `robot1/` (it goes back on what the page sends). Desktop's own keys (dimos/events, the
// gateways) are left alone. It's this page's own (this browser's, or the link's ?namespace=), so two windows can each
// have a robot. A change reloads the page, so every subscription and publisher is made again under it.
// Pure parts: test/namespace.test.ts.
import { Store } from "./store.ts"
import { parseKey, type Topic } from "./transport.ts"
import { readLocal, writeLocal } from "./videoQuality.ts"

const STORAGE_KEY = "lv.namespace"

/** letters, digits and underscores, as dimos allows; nested ones joined by "/" (fleet/robot1); "" = none */
export const cleanNamespace = (name: unknown) => {
    const text = typeof name === "string" ? name.trim().replace(/^\/+|\/+$/g, "") : ""
    return /^[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*$/.test(text) ? text : ""
}

/** a namespace and the ones around it, innermost first, then "" (global): dimos resolves a name in that order */
export const levelsOf = (namespace: string) => namespace ? namespace.split("/").map((_, index, parts) => parts.slice(0, parts.length - index).join("/")).concat("") : [""]

/** the namespace this page runs under (fixed until it reloads) */
let active = ""
export const activeNamespace = () => active

/** Takes this page's namespace (the link's ?namespace=, else this browser's; call once, before connecting). */
export function startNamespace() {
    const linked = new URLSearchParams(location.search).get("namespace")
    active = cleanNamespace(linked ?? readLocal<string>(STORAGE_KEY, ""))
    namespaceChoice.set({ name: active })
}

/** what Settings shows: the namespace this page runs under */
export const namespaceChoice = new Store<{ name: string }>({ name: "" })

/** Picks a namespace ("" = none): kept for this browser, the link's ?namespace= follows, and the page reloads under it. */
export function chooseNamespace(name: string) {
    const clean = cleanNamespace(name)
    writeLocal(STORAGE_KEY, clean)
    const url = new URL(location.href)
    if (clean) {
        url.searchParams.set("namespace", clean)
    } else {
        url.searchParams.delete("namespace")
    }
    location.replace(url.href)
}

/** for tests */
export function setActiveNamespace(name: string) {
    active = cleanNamespace(name)
}

/** dimos keys that aren't topics: Desktop's events and the like, never namespaced */
const SPECIAL = /^dimos\/(events|gateway|rpc)(\/|$)/

/** where each topic the page sees is on the wire (its plain key → the wire key), set from discovery (namespacedTopics) */
let routes = new Map<string, string>()

/**
 * The page's key → the key on the wire: a topic the page sees goes where it was found (the robot's own, or a shared
 * one from an enclosing namespace or the global level); anything else (a topic only the page publishes, like cmd_vel)
 * into the namespace itself: `dimos/<topic>/<type>` → `dimos/<ns>/<topic>/<type>`.
 */
export function toWire(key: string, namespace = active): string {
    if (!namespace || !key.startsWith("dimos/") || SPECIAL.test(key)) {
        return key
    }
    return routes.get(key) ?? `dimos/${namespace}/${key.slice("dimos/".length)}`
}

/** The key on the wire → the page's key: the namespace (or the enclosing one it came from) taken off. */
export function fromWire(key: string, namespace = active): string {
    for (const level of levelsOf(namespace)) {
        if (level && key.startsWith(`dimos/${level}/`)) {
            return `dimos/${key.slice(`dimos/${level}/`.length)}`
        }
    }
    return key
}

const NAME_PART = /^[A-Za-z0-9_]+$/

/**
 * The namespaces on the bus, nested ones too (fleet, fleet/robot1): every leading run of a topic name's parts, unless
 * that run is a topic itself (`/file_info` and its `/file_info/go2` answers).
 */
export function seenNamespaces(topics: Topic[]): string[] {
    const names = new Set(topics.map((topic) => topic.name.replace(/^\/+/, "")))
    const found = new Set<string>()
    for (const name of names) {
        const parts = name.split("/")
        for (let length = 1; length < parts.length && NAME_PART.test(parts[length - 1]); length++) {
            found.add(parts.slice(0, length).join("/"))
        }
    }
    return [...found].filter((prefix) => !names.has(prefix)).sort()
}

/** the innermost namespace a topic is in ("" = none) */
const ownerOf = (name: string, namespaces: string[]) => namespaces.filter((namespace) => name.startsWith(`${namespace}/`)).sort((a, b) => b.length - a.length)[0] ?? ""

/**
 * The topics the page sees under `namespace`, as dimos resolves names there: the namespace's own by their plain names,
 * then the enclosing namespaces' and the global ones (each only where nothing nearer has the same name). Topics of
 * any other namespace (another robot) aren't seen. Also sets where each one is on the wire (toWire).
 */
export function namespacedTopics(topics: Topic[], namespace = active): Topic[] {
    if (!namespace) {
        routes = new Map()
        return topics
    }
    // the picked one and those around it count even when too few topics are there yet to be seen as namespaces
    const namespaces = [...new Set([...seenNamespaces(topics), ...levelsOf(namespace).filter(Boolean)])]
    const seen = new Map<string, Topic>()
    const nextRoutes = new Map<string, string>()
    for (const level of levelsOf(namespace)) {
        for (const topic of topics) {
            const name = topic.name.replace(/^\/+/, "")
            if (ownerOf(name, namespaces) !== level) {
                continue
            }
            const plain = parseKey(level ? `dimos/${topic.key.slice(`dimos/${level}/`.length)}` : topic.key)
            if (plain && !seen.has(plain.key)) {
                seen.set(plain.key, plain)
                nextRoutes.set(plain.key, topic.key)
            }
        }
    }
    routes = nextRoutes
    return [...seen.values()]
}

// ---- TF frames: `robot1/base_link` in, `base_link` in the page, `robot1/base_link` out ----

/** each frame the page saw with a namespace, by its plain name (only those get theirs back on the way out: shared frames stay shared) */
const strippedFrames = new Map<string, string>()

/** `fleet/robot1/base_link` → base_link (the namespace's own, or an enclosing one's), else unchanged */
function plainFrame(frame: string, namespace: string): string {
    for (const level of levelsOf(namespace)) {
        if (level && frame.startsWith(`${level}/`)) {
            const plain = frame.slice(level.length + 1)
            strippedFrames.set(plain, frame)
            return plain
        }
    }
    return frame
}
const FRAME_KEYS = new Set(["frame_id", "child_frame_id"])

const walkable = (value: unknown): value is Record<string, unknown> | unknown[] =>
    typeof value === "object" && value !== null && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer)

/** A decoded message with the namespace taken off its frames (in place: the message is the page's own). */
export function stripFrames<T>(value: T, namespace = active): T {
    if (!namespace) {
        return value
    }
    const walk = (node: unknown, depth: number) => {
        if (!walkable(node) || depth > 8) {
            return
        }
        if (Array.isArray(node)) {
            // a long array of numbers (or of plain values) has no frames
            if (node.length && walkable(node[0])) {
                node.forEach((item) => walk(item, depth + 1))
            }
            return
        }
        for (const [key, child] of Object.entries(node)) {
            if (FRAME_KEYS.has(key) && typeof child === "string") {
                node[key] = plainFrame(child, namespace)
            } else {
                walk(child, depth + 1)
            }
        }
    }
    walk(value, 0)
    return value
}

/** A frame id read straight from the bytes, without the namespace. */
export function stripFrame(frame: string, namespace = active): string {
    return namespace ? plainFrame(frame, namespace) : frame
}

/** A message about to be sent, its frames that came with the namespace given it back (a copy: the caller's is untouched). */
export function prefixFrames<T>(value: T, namespace = active): T {
    if (!namespace || !strippedFrames.size) {
        return value
    }
    const walk = (node: unknown, depth: number): unknown => {
        if (!walkable(node) || depth > 8) {
            return node
        }
        if (Array.isArray(node)) {
            if (!node.length || !walkable(node[0])) {
                return node
            }
            const items = node.map((item) => walk(item, depth + 1))
            return items.some((item, index) => item !== node[index]) ? items : node
        }
        let copy: Record<string, unknown> | null = null
        for (const [key, child] of Object.entries(node)) {
            const next = FRAME_KEYS.has(key) && typeof child === "string" && strippedFrames.has(child) ? strippedFrames.get(child)! : walk(child, depth + 1)
            if (next !== child) {
                copy ??= { ...node }
                copy[key] = next
            }
        }
        return copy ?? node
    }
    return walk(value, 0) as T
}

/** for tests */
export function forgetFrames() {
    strippedFrames.clear()
    routes = new Map()
}

// ---- the zenoh client the page uses ----

/** methods whose first argument is a key */
const KEYED = new Set(["publisher", "get", "querier", "put", "delete", "declareQueryable", "declareToken", "livelinessGet", "matchingStatus", "matchingListener"])

/**
 * The zenoh-gateway client with every dimos key mapped into the namespace: subscriptions (their messages come back
 * with the page's key), publishers, puts, gets, the lease's keys. Topic discovery (listTopics) stays raw: the
 * transport lists everything and picks (namespacedTopics). Without a namespace it's the client itself.
 */
export function namespacedClient<T extends object>(client: T, namespace = active): T {
    if (!namespace) {
        return client
    }
    return new Proxy(client, {
        get(target, prop) {
            const value = Reflect.get(target, prop, target)
            if (typeof value !== "function") {
                return value
            }
            if (prop === "subscribe" || prop === "livelinessSubscribe") {
                return (key: string, options: unknown, callback: (message: { key: string }) => void) =>
                    value.call(target, toWire(key, namespace), options, (message: { key: string }) =>
                        callback(message && typeof message.key === "string" ? Object.assign(message, { key: fromWire(message.key, namespace) }) : message))
            }
            if (KEYED.has(prop as string)) {
                return (key: unknown, ...rest: unknown[]) => value.call(target, typeof key === "string" ? toWire(key, namespace) : key, ...rest)
            }
            if (prop === "lease") {
                return (options: unknown, ...rest: unknown[]) => {
                    if (options && typeof options === "object") {
                        const lease = options as { publish?: string[]; subscribe?: string[] }
                        options = { ...lease, publish: lease.publish?.map((key) => toWire(key, namespace)), subscribe: lease.subscribe?.map((key) => toWire(key, namespace)) }
                    }
                    return value.call(target, options, ...rest)
                }
            }
            return value.bind(target)
        },
    })
}
