// dimos's files.FileInfo (dimos/msgs/files/FileInfo.py), little-endian: <f64 ts><u8 flags><u32 uri length><uri>[<u16 hash length><hash>][<f64 mtime>][content: the rest]
// flags: bit0 sha256 (`sha256:<64 hex>`), bit1 mtime (s since the epoch), bit2 content; no content = header only, empty content = an empty file

export const FILE_INFO_TYPE = "files.FileInfo"

const HAS_SHA256 = 1
const HAS_MTIME = 2
const HAS_CONTENT = 4

export interface FileInfo {
    /** seconds since the epoch the message was made */
    ts: number
    /** the file's path, relative to the module that serves it */
    uri: string
    /** `sha256:<64 hex>` */
    sha256?: string
    /** seconds since the epoch the file last changed */
    mtime?: number
    /** the file's bytes; absent: a header only */
    content?: Uint8Array
}

export function encodeFileInfo(info: FileInfo): Uint8Array {
    const uri = new TextEncoder().encode(info.uri)
    const hash = info.sha256 === undefined ? null : new TextEncoder().encode(info.sha256)
    const content = info.content
    const size = 8 + 1 + 4 + uri.length + (hash ? 2 + hash.length : 0) + (info.mtime === undefined ? 0 : 8) + (content?.length ?? 0)
    const bytes = new Uint8Array(size)
    const view = new DataView(bytes.buffer)
    view.setFloat64(0, info.ts, true)
    view.setUint8(8, (hash ? HAS_SHA256 : 0) | (info.mtime === undefined ? 0 : HAS_MTIME) | (content ? HAS_CONTENT : 0))
    view.setUint32(9, uri.length, true)
    bytes.set(uri, 13)
    let offset = 13 + uri.length
    if (hash) {
        view.setUint16(offset, hash.length, true)
        bytes.set(hash, offset + 2)
        offset += 2 + hash.length
    }
    if (info.mtime !== undefined) {
        view.setFloat64(offset, info.mtime, true)
        offset += 8
    }
    if (content) {
        bytes.set(content, offset)
    }
    return bytes
}

/** Reads a FileInfo (its content a copy of its own); throws when the bytes are shorter than their header says. */
export function decodeFileInfo(bytes: Uint8Array): FileInfo {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const need = (offset: number, length: number) => {
        if (offset + length > bytes.length) {
            throw new Error(`files.FileInfo cut short: ${bytes.length} bytes, its header needs ${offset + length}`)
        }
    }
    need(0, 13)
    const ts = view.getFloat64(0, true)
    const flags = view.getUint8(8)
    const uriLength = view.getUint32(9, true)
    need(13, uriLength)
    const info: FileInfo = { ts, uri: new TextDecoder().decode(bytes.subarray(13, 13 + uriLength)) }
    let offset = 13 + uriLength
    if (flags & HAS_SHA256) {
        need(offset, 2)
        const hashLength = view.getUint16(offset, true)
        need(offset + 2, hashLength)
        info.sha256 = new TextDecoder().decode(bytes.subarray(offset + 2, offset + 2 + hashLength))
        offset += 2 + hashLength
    }
    if (flags & HAS_MTIME) {
        need(offset, 8)
        info.mtime = view.getFloat64(offset, true)
        offset += 8
    }
    if (flags & HAS_CONTENT) {
        info.content = bytes.slice(offset)
    }
    return info
}
