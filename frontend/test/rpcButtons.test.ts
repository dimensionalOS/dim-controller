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
