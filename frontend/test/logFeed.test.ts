// The Logs panel's filters and the Logs chip's count (core/logFeed.ts), and the panel closed in any layout until asked for.
import { assertEquals } from "jsr:@std/assert@1"
import { appendRecords, filterRecords, type LoggedRecord, MAX_RECORDS, unseenProblems } from "../src/core/logFeed.ts"
import { normalizeArrangement, showPanel } from "../src/ui/workspace.ts"

const record = (timestamp: string, level: string, logger: string, event: string): LoggedRecord => ({ timestamp, level, logger, event, raw: JSON.stringify({ event, level, logger, timestamp }) })
const RECORDS = [
    record("2026-11-18T10:00:00Z", "info", "dimos/core/module.py", "started"),
    record("2026-11-18T10:00:01Z", "warning", "dimos/navigation/planner.py", "no route"),
    record("2026-11-18T10:00:02Z", "error", "dimos/protocol/rpc/zenohrpc.py", "Exception in RPC handler"),
    record("2026-11-18T10:00:03Z", "debug", "dimos/core/module.py", "tick"),
]

Deno.test("the chip counts warnings and errors newer than the last one seen", () => {
    assertEquals(unseenProblems(RECORDS, ""), { warnings: 1, errors: 1 })
    assertEquals(unseenProblems(RECORDS, "2026-11-18T10:00:01Z"), { warnings: 0, errors: 1 })
    assertEquals(unseenProblems(RECORDS, "2026-11-18T10:00:03Z"), { warnings: 0, errors: 0 })
})

Deno.test("filters: lowest level, search anywhere in the record, a group by part of a logger's name", () => {
    const events = (filter: Parameters<typeof filterRecords>[1]) => filterRecords(RECORDS, filter).map((one) => one.event)
    assertEquals(events({ level: "info", query: "", group: "" }), ["started", "no route", "Exception in RPC handler"])
    assertEquals(events({ level: "debug", query: "", group: "module.py" }), ["started", "tick"])
    assertEquals(events({ level: "warning", query: "", group: "" }), ["no route", "Exception in RPC handler"])
    assertEquals(events({ level: "debug", query: "ZENOH", group: "" }), ["Exception in RPC handler"])
    assertEquals(events({ level: "debug", query: "", group: "dimos/navigation/planner.py" }), ["no route"])
})

Deno.test("the oldest records go past the cap", () => {
    const many = Array.from({ length: MAX_RECORDS }, (_, index) => record(String(index), "info", "a", String(index)))
    const kept = appendRecords(many, [record("new", "info", "a", "new")])
    assertEquals([kept.length, kept[0].event, kept.at(-1)!.event], [MAX_RECORDS, "1", "new"])
})

Deno.test("the Logs panel is closed in a layout saved before it existed, and opens when shown", () => {
    const ids = ["map", "scene", "settings", "tf", "logs"]
    const old = normalizeArrangement({ stage: "scene", left: ["map"], right: ["settings", "tf"], closed: [] }, ids)
    assertEquals([old.right, old.closed], [["settings", "tf"], ["logs"]])
    const shown = normalizeArrangement(showPanel(old, "logs"), ids)
    assertEquals([shown.right, shown.closed], [["settings", "tf", "logs"], []])
})
