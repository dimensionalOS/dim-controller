// Hardware files (core/hardwareFiles.ts) kept in IndexedDB across reloads: bytes by sha256 (a changed file is a new hash, so nothing is ever stale)
// and the hash last served for each module's file name, so a reload asks conditionally; without IndexedDB nothing is kept and everything is asked for
import { meshLog } from "./meshCache.ts"

const DB_NAME = "dim-controller-hardware-files"
/** sha256 → the file's bytes */
const FILES = "files"
/** `<namespace>\n<uri>` → the sha256 it was last served as */
const NAMES = "names"

let database: Promise<IDBDatabase | null> | null = null

/** forgets the open database, as a reload does (tests) */
export function resetHardwareCache() {
    database = null
}

function openCache(): Promise<IDBDatabase | null> {
    database ??= new Promise((resolve) => {
        try {
            const request = indexedDB.open(DB_NAME, 1)
            request.onupgradeneeded = () => {
                request.result.createObjectStore(FILES)
                request.result.createObjectStore(NAMES)
            }
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => {
                meshLog("no hardware cache: can't open IndexedDB:", request.error)
                resolve(null)
            }
            request.onblocked = () => resolve(null)
        } catch (error) {
            meshLog("no hardware cache: IndexedDB unavailable:", error)
            resolve(null)
        }
    })
    return database
}

async function read<T>(store: string, key: string): Promise<T | null> {
    const db = await openCache()
    return new Promise((resolve) => {
        try {
            const request = db!.transaction(store, "readonly").objectStore(store).get(key)
            request.onsuccess = () => resolve((request.result as T | undefined) ?? null)
            request.onerror = () => resolve(null)
        } catch {
            resolve(null)
        }
    })
}

async function write(store: string, key: string, value: unknown): Promise<void> {
    const db = await openCache()
    return new Promise((resolve) => {
        try {
            const transaction = db!.transaction(store, "readwrite")
            transaction.objectStore(store).put(value, key)
            transaction.oncomplete = () => resolve()
            transaction.onabort = () => {
                meshLog(`storing ${key} failed:`, transaction.error)
                resolve()
            }
        } catch {
            resolve()
        }
    })
}

const nameKey = (namespace: string, uri: string) => `${namespace}\n${uri}`

/** the cached bytes with this sha256, or null */
export async function cachedBytes(sha256: string): Promise<Uint8Array | null> {
    const bytes = await read<Uint8Array>(FILES, sha256)
    return bytes instanceof Uint8Array ? bytes : null
}

export const storeBytes = (sha256: string, bytes: Uint8Array) => write(FILES, sha256, bytes)

/** the sha256 this module's file was last served as, or null */
export async function knownHash(namespace: string, uri: string): Promise<string | null> {
    const hash = await read<string>(NAMES, nameKey(namespace, uri))
    return typeof hash === "string" ? hash : null
}

export const rememberHash = (namespace: string, uri: string, sha256: string) => write(NAMES, nameKey(namespace, uri), sha256)
