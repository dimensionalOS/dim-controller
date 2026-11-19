// The running blueprint's dimos log (core/logFeed.ts) as a panel, its tools in one row: a Group button (its popover
// picks one logger, or any whose name has the typed text), a search and follow. The detail (the lowest level shown) is
// picked by clicking a line's level. Each record is one line until clicked (its fields and traceback unfold under it),
// so a long log scrolls quickly. While it shows, every record counts as seen, so the bar's Logs chip
// (ui/BarChips.tsx) goes away.
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Button, Card, Checkbox, LOG_LEVELS, SearchInput, Segmented, splitRecord, TextInput, Traceback } from "dimos-react"
import { useStore } from "../core/store.ts"
import { filterRecords, type LogFilter, logFeed, type LoggedRecord } from "../core/logFeed.ts"
import { readLocal, writeLocal } from "../core/videoQuality.ts"
import { useWorkspaceApi } from "./Workspace.tsx"
import { useDismiss } from "./Panel.tsx"

/** at most this many of the matching records are drawn (the newest) */
const SHOWN_MAX = 500
// v2: the default detail became warning; a filter saved under the old key kept info
const FILTER_KEY = "lv.logs.filter.v2"
/** how far from the bottom still counts as at the bottom (px) */
const BOTTOM_SLACK = 24

const shortTime = (timestamp: string) => /T?(\d\d:\d\d:\d\d)/.exec(timestamp)?.[1] ?? timestamp
const fieldText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value))

/** a React key per record object (the feed keeps each record's object as it appends and drops) */
const keys = new WeakMap<LoggedRecord, number>()
let nextKey = 0
const keyOf = (record: LoggedRecord) => keys.get(record) ?? (keys.set(record, ++nextKey), nextKey)

/** One record: a line (time, level, logger, event, what unfolds), and unfolded, its fields and its traceback. */
function Record({ record, open, onToggle, onLevel, levelPicker }: { record: LoggedRecord; open: boolean; onToggle: () => void; onLevel: () => void; levelPicker: ReactNode }) {
    const { traceback, where, fields } = splitRecord(record)
    const level = record.level.toLowerCase()
    const more = [traceback && "traceback", fields.length && `${fields.length} field${fields.length === 1 ? "" : "s"}`].filter(Boolean).join(", ")
    return (
        <div className={`dr-slog__rec dr-slog__rec--${level} logs-rec ${open ? "open" : ""}`}>
            {/* not a <button>, so its text can be selected; a click that ends a selection doesn't fold it */}
            <div
                role="button"
                tabIndex={0}
                className="logs-line"
                onClick={() => !globalThis.getSelection?.()?.toString() && onToggle()}
                onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && (event.preventDefault(), onToggle())}
                title={open ? "Fold" : more ? `Unfold: ${more}` : record.raw}
                aria-expanded={open}
            >
                <span className="logs-fold" aria-hidden>{more ? (open ? "▾" : "▸") : ""}</span>
                <span className="dr-slog__ts">{shortTime(record.timestamp)}</span>
                <span
                    className="dr-slog__lv logs-lv"
                    role="button"
                    title="Pick the detail: this level and up, or another"
                    data-testid="logs-level"
                    onClick={(event) => {
                        event.stopPropagation()
                        onLevel()
                    }}
                >
                    {record.level}
                </span>
                {record.logger && <span className="dr-slog__logger" title={record.logger}>{open ? record.logger : record.logger.split("/").slice(-2).join("/")}</span>}
                <span className="logs-event">{record.event}</span>
                {!open && more && <span className="logs-more">{more}</span>}
            </div>
            {levelPicker}
            {open && (
                <div className="logs-detail">
                    {where && <div className="dr-slog__field"><span className="dr-slog__key">at</span>{where}</div>}
                    {fields.map(([key, value]) => (
                        <div key={key} className="dr-slog__field">
                            <span className="dr-slog__key">{key}</span>
                            <pre>{fieldText(value).replace(/\n$/, "")}</pre>
                        </div>
                    ))}
                    {traceback && <Traceback text={traceback} className="dr-slog__tb" />}
                </div>
            )}
        </div>
    )
}

/** The Group button and its popover: one logger, typed or picked from every logger. */
function FilterMenu({ filter, loggers, change }: { filter: LogFilter; loggers: string[]; change: (patch: Partial<LogFilter>) => void }) {
    const [open, setOpen] = useState(false)
    useDismiss(open, ".logs-filter", () => setOpen(false))
    const typed = filter.group.trim().toLowerCase()
    const listed = typed && !loggers.includes(filter.group) ? loggers.filter((name) => name.toLowerCase().includes(typed)) : loggers
    const groupLabel = filter.group ? filter.group.split("/").slice(-2).join("/") : "all groups"
    return (
        <span className="logs-filter">
            <Button size="sm" className="logs-filter-button" pressed={open} aria-expanded={open} title="Group: one logger" data-testid="logs-filter" onClick={() => setOpen(!open)}>
                <span className="logs-filter-text">{groupLabel}</span>
                <span aria-hidden>▾</span>
            </Button>
            {open && (
                <Card padded className="logs-filter-pop" role="dialog" aria-label="Log filter">
                    <TextInput size="sm" placeholder="type part of a logger's name" aria-label="group: a logger, or part of its name" value={filter.group} onChange={(group) => change({ group })} data-testid="logs-group" autoFocus />
                    <div className="logs-groups dr-scroll">
                        <button type="button" className={`logs-group-item ${filter.group ? "" : "selected"}`} onClick={() => change({ group: "" })}>all groups</button>
                        {listed.map((name) => (
                            <button key={name} type="button" className={`logs-group-item ${filter.group === name ? "selected" : ""}`} title={name} onClick={() => change({ group: name })}>{name}</button>
                        ))}
                        {!listed.length && <div className="logs-group-none">no logger has "{filter.group}" (it still filters what comes)</div>}
                    </div>
                </Card>
            )}
        </span>
    )
}

/** The detail picker under a line whose level was clicked: the lowest level shown. */
function LevelPicker({ level, onPick, onClose }: { level: string; onPick: (level: string) => void; onClose: () => void }) {
    useDismiss(true, ".logs-level-pop, .logs-lv", onClose)
    return (
        <Card padded className="logs-level-pop" role="dialog" aria-label="Detail">
            <span className="logs-filter-title">Detail: this level and up</span>
            <Segmented size="sm" items={LOG_LEVELS.map((name) => [name, name] as const)} value={level} onChange={onPick} label="lowest level" />
        </Card>
    )
}

export function LogsPanel() {
    const api = useWorkspaceApi()
    const feed = useStore(logFeed.state)
    const [filter, setFilter] = useState<LogFilter>(() => ({ level: "warning", query: "", group: "", ...readLocal<Partial<LogFilter>>(FILTER_KEY, {}) }))
    const [follow, setFollow] = useState(true)
    const [open, setOpen] = useState<ReadonlySet<LoggedRecord>>(() => new Set())
    // the line whose level was clicked: the detail picker shows under it
    const [picking, setPicking] = useState<LoggedRecord | null>(null)
    const body = useRef<HTMLDivElement>(null)
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
    useLayoutEffect(() => {
        if (follow && body.current) {
            body.current.scrollTop = body.current.scrollHeight
        }
    }, [shown, follow])
    const atBottom = () => {
        const element = body.current!
        return element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_SLACK
    }
    const toggle = (record: LoggedRecord) => {
        const next = new Set(open)
        if (!next.delete(record)) {
            next.add(record)
            // unfolding is reading back up: stop following
            setFollow(false)
        }
        setOpen(next)
    }
    const run = feed.runId ? `${feed.runId}${feed.running ? "" : " (stopped)"}` : null
    const note = feed.note ?? (feed.runId && !shown.length ? (feed.records.length ? "Nothing matches these filters." : "No log lines yet.") : null)
    return (
        <div className="dr-slog logs-panel" data-testid="logs-panel">
            <div className="dr-slog__tools logs-tools">
                <FilterMenu filter={filter} loggers={feed.loggers} change={change} />
                <SearchInput className="logs-search" placeholder={`search ${feed.records.length} logs`} aria-label="search the log" title={run ?? undefined} value={filter.query} onChange={(query) => change({ query })} />
                <Checkbox label="follow" value={follow} onChange={setFollow} title="Keep the newest line in view" />
                {open.size > 0 && <button type="button" className="link logs-fold-all" onClick={() => setOpen(new Set())}>fold all</button>}
            </div>
            <div ref={body} className="dr-slog__body dr-scroll" onScroll={() => atBottom() !== follow && setFollow(atBottom())}>
                {note && <div className="dr-slog__note">{note}</div>}
                {shown.map((record) => (
                    <Record
                        key={keyOf(record)}
                        record={record}
                        open={open.has(record)}
                        onToggle={() => toggle(record)}
                        onLevel={() => setPicking(picking === record ? null : record)}
                        levelPicker={picking === record && (
                            <LevelPicker
                                level={filter.level}
                                onPick={(level) => {
                                    change({ level })
                                    setPicking(null)
                                }}
                                onClose={() => setPicking(null)}
                            />
                        )}
                    />
                ))}
            </div>
        </div>
    )
}
