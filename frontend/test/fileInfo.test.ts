// files.FileInfo (core/fileInfo.ts): the wire form dimos/msgs/files/FileInfo.py writes, byte for byte, and every optional part round trip
import { assertEquals, assertThrows } from "jsr:@std/assert@1"
import { decodeFileInfo, encodeFileInfo, type FileInfo } from "../src/core/fileInfo.ts"

const HASH = `sha256:${"ab".repeat(32)}`
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
const fromHex = (text: string) => new Uint8Array(text.match(/../g)!.map((pair) => parseInt(pair, 16)))

// what FileInfo.py's lcm_encode wrote (struct.pack "<dB", "<I", "<H", "<d"), so both sides read one format
const FULL_FROM_PYTHON = "000000000000f83f070f0000006d65736865732f626173652e6f626a47007368613235363a" + "6162".repeat(32) + "0000000000000240010203"
const HEADER_FROM_PYTHON = "000000000000f83f000d00000068617264776172652e75736461"

Deno.test("the bytes are FileInfo.py's: every part, and a bare header", () => {
    const full: FileInfo = { ts: 1.5, uri: "meshes/base.obj", sha256: HASH, mtime: 2.25, content: new Uint8Array([1, 2, 3]) }
    assertEquals(hex(encodeFileInfo(full)), FULL_FROM_PYTHON)
    assertEquals(decodeFileInfo(fromHex(FULL_FROM_PYTHON)), full)
    assertEquals(hex(encodeFileInfo({ ts: 1.5, uri: "hardware.usda" })), HEADER_FROM_PYTHON)
    assertEquals(decodeFileInfo(fromHex(HEADER_FROM_PYTHON)), { ts: 1.5, uri: "hardware.usda" })
})

Deno.test("a header only, an empty file and a file are three different things", () => {
    const header = decodeFileInfo(encodeFileInfo({ ts: 3, uri: "a.obj", sha256: HASH }))
    const empty = decodeFileInfo(encodeFileInfo({ ts: 3, uri: "a.obj", sha256: HASH, content: new Uint8Array() }))
    const file = decodeFileInfo(encodeFileInfo({ ts: 3, uri: "a.obj", sha256: HASH, content: new Uint8Array([9]) }))
    assertEquals(header.content, undefined, "no content: a header only")
    assertEquals(empty.content, new Uint8Array(), "content of length 0: an empty file")
    assertEquals(file.content, new Uint8Array([9]))
})

Deno.test("hash and mtime each optional, alone or together", () => {
    for (const info of [{ ts: 0, uri: "x" }, { ts: 0, uri: "x", sha256: HASH }, { ts: 0, uri: "x", mtime: 1700000000.25 }, { ts: 0, uri: "x", sha256: HASH, mtime: 1 }] as FileInfo[]) {
        assertEquals(decodeFileInfo(encodeFileInfo(info)), info)
    }
    assertEquals(decodeFileInfo(encodeFileInfo({ ts: 0, uri: "ünï/çødé.usda", content: new Uint8Array([0]) })).uri, "ünï/çødé.usda", "the uri's length is in bytes, not characters")
})

Deno.test("a view into a bigger buffer reads as itself, and its content doesn't share that buffer", () => {
    const bytes = encodeFileInfo({ ts: 2, uri: "b.stl", content: new Uint8Array([4, 5]) })
    const padded = new Uint8Array(bytes.length + 10)
    padded.set(bytes, 5)
    const decoded = decodeFileInfo(padded.subarray(5, 5 + bytes.length))
    assertEquals([decoded.uri, decoded.content], ["b.stl", new Uint8Array([4, 5])])
    assertEquals(decoded.content!.buffer.byteLength, 2, "a copy, so caching it doesn't keep the whole message")
})

Deno.test("bytes shorter than their header says throw", () => {
    const bytes = encodeFileInfo({ ts: 0, uri: "hardware.usda", sha256: HASH, mtime: 1 })
    for (const cut of [5, 13, 20, bytes.length - 1]) {
        assertThrows(() => decodeFileInfo(bytes.subarray(0, cut)))
    }
})
