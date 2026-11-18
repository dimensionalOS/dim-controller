// LCM wire format: dimos-react's codec (its schemas are this app's schemas.json, made by tools/gen_lcm_schemas.ts).
// Frames pass through the robot namespace (core/namespace.ts): `robot1/base_link` decodes as base_link, and back on encode.
import { decodeLcm, encodeLcm, headerFrameId as rawHeaderFrameId } from "dimos-react"
import { prefixFrames, stripFrame, stripFrames } from "../namespace.ts"
export { lcmFingerprint as fingerprint, lcmSchemas as schemas } from "dimos-react"

export const decode: typeof decodeLcm = (...args: Parameters<typeof decodeLcm>) => stripFrames(decodeLcm(...args))
export const encode: typeof encodeLcm = (type, value, ...rest) => encodeLcm(type, prefixFrames(value), ...rest)
export const headerFrameId: typeof rawHeaderFrameId = (...args: Parameters<typeof rawHeaderFrameId>) => {
    const frame = rawHeaderFrameId(...args)
    return typeof frame === "string" ? stripFrame(frame) : frame
}

/** a decoded message (the schema's fields; nested messages are objects) */
// deno-lint-ignore no-explicit-any
export type LcmValue = any
