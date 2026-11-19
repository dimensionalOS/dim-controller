// A name's own hue (FNV-1a), so the same name is always the same color: the Logs panel's loggers, the 3D view's layer types.
export function hashHue(name: string): number {
    let hash = 0x811c9dc5
    for (let index = 0; index < name.length; index++) {
        hash = Math.imul(hash ^ name.charCodeAt(index), 0x01000193)
    }
    return (hash >>> 0) % 360
}
