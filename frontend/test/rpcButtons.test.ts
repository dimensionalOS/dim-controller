import { assertEquals } from "jsr:@std/assert@1"
import { zeroArgRpcs } from "../src/core/rpcButtons.ts"

Deno.test("only RPCs the scan saw take no parameters get a button", () => {
    const buttons = zeroArgRpcs([
        { id: "m20connection", rpcs: [{ name: "standup", doc: "Stand.", params: [] }, { name: "move", params: [{ name: "twist" }] }, { name: "unscanned", params: null }] },
        { id: "planner", rpcs: [{ name: "stop_navigation", params: [] }] },
        { id: "empty" },
    ])
    assertEquals(buttons, [
        { module: "m20connection", name: "standup", label: "Standup", doc: "Stand." },
        { module: "planner", name: "stop_navigation", label: "Stop Navigation", doc: "" },
    ])
})

Deno.test("RPCs returning nothing come first, then a bool, then the rest (unannotated with the rest)", () => {
    const names = zeroArgRpcs([
        { id: "a", rpcs: [{ name: "status", params: [], return_type: "str" }, { name: "standup", params: [], return_type: "bool" }, { name: "odd", params: [], return_type: null }] },
        { id: "b", rpcs: [{ name: "stop", params: [], return_type: "None" }, { name: "ready", params: [], return_type: "bool" }] },
    ]).map((button) => button.name)
    assertEquals(names, ["stop", "standup", "ready", "status", "odd"])
})
