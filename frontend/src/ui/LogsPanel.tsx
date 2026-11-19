// The running blueprint's dimos log (core/logFeed.ts) as a panel: a search on top; it follows the newest line while
// scrolled to the bottom. The detail (the lowest level shown) is picked by clicking a line's level, the group (one
// logger, or any whose name has the typed text) by clicking its logger, each in a picker under that line; a set group
// shows on top until cleared. Each logger has its own color (from its name's hash). Each record is one line until
// clicked (its fields and traceback unfold under it), so a long log scrolls quickly. While it shows, every record
// counts as seen, so the bar's Logs chip (ui/BarChips.tsx) goes away.
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Card, LOG_LEVELS, SearchInput, Segmented, splitRecord, TextInput, Traceback } from "dimos-react"
import { useStore } from "../core/store.ts"
import { hashHue } from "../core/hashHue.ts"
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


/** whether the theme's background is dark (the loggers' colors are lighter on it) */
function useDarkTheme(): boolean {
    const read = () => {
        const [r, g, b] = (getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g) ?? ["0", "0", "0"]).map(Number)
        return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128
    }
    const [dark, setDark] = useState(read)
    useEffect(() => {
        const changed = () => setDark(read())
        addEventListener("dimos-react-theme", changed)
        return () => removeEventListener("dimos-react-theme", changed)
    }, [])
    return dark
}

const loggerColor = (name: string, dark: boolean) => `hsl(${hashHue(name)} 60% ${dark ? 66 : 36}%)`

/** One record: a line (time, level, logger, event, what unfolds), and unfolded, its fields and its traceback. */
function Record({ record, open, dark, onToggle, onLevel, onGroup, picker }: { record: LoggedRecord; open: boolean; dark: boolean; onToggle: () => void; onLevel: () => void; onGroup: () => void; picker: ReactNode }) {
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
                {record.logger && (
                    <span
                        className="dr-slog__logger logs-logger"
                        role="button"
                        style={{ color: loggerColor(record.logger, dark) }}
                        title={`${record.logger}: pick the group`}
                        data-testid="logs-logger"
                        onClick={(event) => {
                            event.stopPropagation()
                            onGroup()
                        }}
                    >
                        {open ? record.logger : record.logger.split("/").slice(-2).join("/")}
                    </span>
                )}
                <span className="logs-event">{record.event}</span>
                {!open && more && <span className="logs-more">{more}</span>}
            </div>
            {picker}
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

/** The group picker under a line whose logger was clicked: that logger, any other, or part of a name typed. */
function GroupPicker({ group, logger, loggers, dark, onPick, onType, onClose }: { group: string; logger: string; loggers: string[]; dark: boolean; onPick: (group: string) => void; onType: (group: string) => void; onClose: () => void }) {
    useDismiss(true, ".logs-group-pop, .logs-logger", onClose)
    const typed = group.trim().toLowerCase()
    const listed = typed && !loggers.includes(group) ? loggers.filter((name) => name.toLowerCase().includes(typed)) : loggers
    const item = (name: string, label = name) => (
        <button key={label} type="button" className={`logs-group-item ${group === name ? "selected" : ""}`} style={name ? { color: loggerColor(name, dark) } : undefined} title={name || "every logger"} onClick={() => onPick(name)}>{label}</button>
    )
    return (
        <Card padded className="logs-pop logs-group-pop" role="dialog" aria-label="Group">
            <span className="logs-filter-title">Group</span>
            <TextInput size="sm" placeholder="type part of a logger's name" aria-label="group: a logger, or part of its name" value={group} onChange={onType} onEnter={onClose} data-testid="logs-group" autoFocus />
            <div className="logs-groups dr-scroll">
                {item("", "all groups")}
                {item(logger, `${logger} (this line's)`)}
                {listed.filter((name) => name !== logger).map((name) => item(name))}
                {!listed.length && <div className="logs-group-none">no logger has "{group}" (it still filters what comes)</div>}
            </div>
        </Card>
    )
}

/** The detail picker under a line whose level was clicked: the lowest level shown. */
function LevelPicker({ level, onPick, onClose }: { level: string; onPick: (level: string) => void; onClose: () => void }) {
    useDismiss(true, ".logs-level-pop, .logs-lv", onClose)
    return (
        <Card padded className="logs-pop logs-level-pop" role="dialog" aria-label="Detail">
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
    // the line whose level or logger was clicked: its picker shows under it
    const [picking, setPicking] = useState<{ record: LoggedRecord; kind: "level" | "group" } | null>(null)
    const dark = useDarkTheme()
    const pick = (record: LoggedRecord, kind: "level" | "group") => setPicking(picking?.record === record && picking.kind === kind ? null : { record, kind })
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
                {filter.group && (
                    <button type="button" className="logs-group-chip" title="Showing only this group: clear it" style={{ color: loggerColor(filter.group, dark) }} data-testid="logs-group-chip" onClick={() => change({ group: "" })}>
                        {filter.group.split("/").slice(-2).join("/")} ✕
                    </button>
                )}
                <SearchInput className="logs-search" placeholder={`search ${feed.records.length} logs`} aria-label="search the log" title={run ?? undefined} value={filter.query} onChange={(query) => change({ query })} />
                {open.size > 0 && <button type="button" className="link logs-fold-all" onClick={() => setOpen(new Set())}>fold all</button>}
            </div>
            <div ref={body} className="dr-slog__body dr-scroll" onScroll={() => atBottom() !== follow && setFollow(atBottom())}>
                {note && <div className="dr-slog__note">{note}</div>}
                {shown.map((record) => (
                    <Record
                        key={keyOf(record)}
                        record={record}
                        open={open.has(record)}
                        dark={dark}
                        onToggle={() => toggle(record)}
                        onLevel={() => pick(record, "level")}
                        onGroup={() => pick(record, "group")}
                        picker={picking?.record === record && (picking.kind === "level"
                            ? (
                                <LevelPicker
                                    level={filter.level}
                                    onPick={(level) => {
                                        change({ level })
                                        setPicking(null)
                                    }}
                                    onClose={() => setPicking(null)}
                                />
                            )
                            : (
                                <GroupPicker
                                    group={filter.group}
                                    logger={record.logger}
                                    loggers={feed.loggers}
                                    dark={dark}
                                    onPick={(group) => {
                                        change({ group })
                                        setPicking(null)
                                    }}
                                    onType={(group) => change({ group })}
                                    onClose={() => setPicking(null)}
                                />
                            ))}
                    />
                ))}
            </div>
        </div>
    )
}
