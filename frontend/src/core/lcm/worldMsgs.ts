// dimos-lcm's world_msgs (branch jeff/feat/sim2_world: a simulated world's WorldObservations, BodyState per body),
// which the pinned dimos-react's schemas predate: added to its schema table so decode() reads them. Drop this once
// dimos-react's vendor/lcm_schemas.js has them (tools/gen_lcm_schemas.ts over a dimos_lcm with world_msgs).
import { lcmSchemas } from "dimos-react"

const f = (name: string, type: string, dims: (number | string)[] = []) => ({ name, type, dims })

export const WORLD_MSGS = {
    "world_msgs.CborKeyValue": [f("entity_id", "int64_t"), f("key", "string"), f("value_length", "int32_t"), f("value", "byte", ["value_length"])],
    "world_msgs.BodyState": [f("entity_id", "int64_t"), f("pose", "double", [7]), f("velocity", "double", [6]), f("acceleration", "double", [6])],
    "world_msgs.JointState": [f("entity_id", "int64_t"), f("position", "double"), f("velocity", "double"), f("effort", "double")],
    "world_msgs.WorldObservations": [
        f("ts", "int64_t"),
        f("frame", "int64_t"),
        f("cbor_key_values_length", "int32_t"),
        f("cbor_key_values", "world_msgs.CborKeyValue", ["cbor_key_values_length"]),
        f("body_states_length", "int32_t"),
        f("body_states", "world_msgs.BodyState", ["body_states_length"]),
        f("joint_states_length", "int32_t"),
        f("joint_states", "world_msgs.JointState", ["joint_states_length"]),
    ],
}

for (const [type, fields] of Object.entries(WORLD_MSGS)) {
    lcmSchemas[type] ??= fields
}
