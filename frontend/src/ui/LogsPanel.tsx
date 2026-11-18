// The running blueprint's dimos log (core/logFeed.ts) as a panel: the lowest level, a search, a group (one logger, or
// any whose name has the typed text: a list to pick from, or type it) and follow. While it shows, every record counts
// as seen, so the bar's Logs chip (ui/BarChips.tsx) goes away.
import { useEffect, useMemo, useState } from "react"
import { StructuredLog, TextInput } from "dimos-react"
import { useStore } from "../core/store.ts"
import { filterRecords, type LogFilter, logFeed } from "../core/logFeed.ts"
import { readLocal, writeLocal } from "../core/videoQuality.ts"
import { useWorkspaceApi } from "./Workspace.tsx"

/** at most this many of the matching records are drawn (the newest) */
const SHOWN_MAX = 500
const FILTER_KEY = "lv.logs.filter"

export function LogsPanel() {
    const api = useWorkspaceApi()
    const feed = useStore(logFeed.state)
    const [filter, setFilter] = useState<LogFilter>(() => ({ level: "info", query: "", group: "", ...readLocal<Partial<LogFilter>>(FILTER_KEY, {}) }))
    const [follow, setFollow] = useState(true)
    const change = (patch: Partial<LogFilter>) => {
        const next = { ...filter, ...patch }
        setFilter(next)
        writeLocal(FILTER_KEY, next)
    }
    useEffect(() => logFeed.start(), [])
    const slot = api.layout.slots.logs
    const showing = !!slot && !slot.collapsed && !slot.hidden
    useEffect(() => {
        if (showing) {
            logFeed.markSeen()
        }
    }, [showing, feed.records])
    const matching = useMemo(() => filterRecords(feed.records, filter), [feed.records, filter])
    const shown = matching.length > SHOWN_MAX ? matching.slice(-SHOWN_MAX) : matching
    const run = feed.runId ? `${feed.runId}${feed.running ? "" : " (stopped)"}` : null
    return (
        <StructuredLog
            className="logs-panel"
            data-testid="logs-panel"
            records={shown}
            follow={follow}
            onFollowChange={setFollow}
            level={filter.level}
            onLevelChange={(level) => change({ level })}
            query={filter.query}
            onQueryChange={(query) => change({ query })}
            note={feed.note ?? (feed.runId && !shown.length ? (feed.records.length ? "Nothing matches these filters." : "No log lines yet.") : null)}
            banner={
                <div className="logs-group-row">
                    <TextInput
                        size="sm"
                        className="logs-group"
                        list="logs-groups"
                        placeholder="Group: all"
                        aria-label="group: a logger, or part of its name"
                        title="A logger: pick one, or type part of a name"
                        value={filter.group}
                        onChange={(group) => change({ group })}
                        data-testid="logs-group"
                    />
                    <datalist id="logs-groups">
                        {feed.loggers.map((name) => <option key={name} value={name} />)}
                    </datalist>
                    <span className="logs-count" title={run ?? undefined}>
                        {matching.length > shown.length ? `newest ${shown.length} of ${matching.length}` : `${matching.length} of ${feed.records.length}`}
                        {run && <> · {run}</>}
                    </span>
                </div>
            }
        />
    )
}
