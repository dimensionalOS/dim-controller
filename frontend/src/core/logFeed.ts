// The running blueprint's dimos log (its main.jsonl), from the dimos gateway: GET /history/latest/logs once (the newest
// run's last records), then ?after=<offset> each time the gateway's `log` event says that run's log grew (polled instead
// when the gateway says nothing watches it). The Logs panel shows it; the bar's Logs chip counts the warnings and errors
// newer than the last one anyone saw in the panel (kept per run in localStorage). Pure parts: test/logFeed.test.ts.
import { getZenoh } from "dimos-react/dim-app/zenoh.js"
import type { LogRecord } from "dimos-react"
import { Store } from "./store.ts"
import { readLocal, writeLocal } from "./videoQuality.ts"

/** records kept (the oldest go first) */
export const MAX_RECORDS = 5000
/** records asked for when a run's log is first read */
const FIRST_READ = 1000
/** a log nothing watches (watched false) is asked again this often */
const UNWATCHED_POLL_MS = 3000
/** what's running is asked again this often, besides on the gateway's run events */
const ACTIVE_POLL_MS = 30_000
const SEEN_KEY = "lv.logs.seen"

export type LoggedRecord = LogRecord & { logger: string }

export interface LogFeedState {
    /** the run read (the newest with a log), null before the first answer */
    runId: string | null
    /** that run is the one running now */
    running: boolean
    records: LoggedRecord[]
    /** every logger name in the records */
    loggers: string[]
    /** the newest record's time anyone saw in the Logs panel ("" = none yet) */
    seen: string
    /** why there's nothing: no dimos gateway, no run with a log yet */
    note: string | null
}

export const LEVEL_RANK: Record<string, number> = { debug: 0, info: 1, warning: 2, warn: 2, error: 3, exception: 3, critical: 4, fatal: 4 }
export const levelRank = (level: string) => LEVEL_RANK[level.toLowerCase()] ?? 1

/** The warnings and the errors (critical included) newer than `seen`. */
export function unseenProblems(records: LoggedRecord[], seen: string): { warnings: number; errors: number } {
    let warnings = 0
    let errors = 0
    for (let index = records.length - 1; index >= 0; index--) {
        const record = records[index]
        if (seen && record.timestamp <= seen) {
            break
        }
        const rank = levelRank(record.level)
        if (rank >= 3) {
            errors++
        } else if (rank === 2) {
            warnings++
        }
    }
    return { warnings, errors }
}

export interface LogFilter {
    /** the lowest level shown */
    level: string
    /** in the event, the logger or the record as written (any case) */
    query: string
    /** a logger name or part of one (any case) */
    group: string
}

export function filterRecords(records: LoggedRecord[], filter: LogFilter): LoggedRecord[] {
    const lowest = levelRank(filter.level)
    const query = filter.query.trim().toLowerCase()
    const group = filter.group.trim().toLowerCase()
    return records.filter((record) =>
        levelRank(record.level) >= lowest &&
        (!group || record.logger.toLowerCase().includes(group)) &&
        (!query || record.event.toLowerCase().includes(query) || record.logger.toLowerCase().includes(query) || (record.raw ?? "").toLowerCase().includes(query))
    )
}

/** `records` then `more`, the oldest dropped past MAX_RECORDS. */
export function appendRecords(records: LoggedRecord[], more: LoggedRecord[]): LoggedRecord[] {
    const all = records.length ? [...records, ...more] : more
    return all.length > MAX_RECORDS ? all.slice(all.length - MAX_RECORDS) : all
}

type RunLog = { runId: string; records: LogRecord[]; offset: number; loggers: string[]; watched?: boolean }

const gatewayUrl = (path: string) => new URL(`../../gateways/dimos/${path}`, location.href)

class LogFeed {
    readonly state = new Store<LogFeedState>({ runId: null, running: false, records: [], loggers: [], seen: "", note: null })
    #started = false
    #offset: number | null = null
    #pending: Promise<void> | null = null
    #again = false
    #poll: ReturnType<typeof setInterval> | null = null

    /** Starts following (once; the chip and the panel both ask). */
    start() {
        if (this.#started) {
            return
        }
        this.#started = true
        const zenoh = getZenoh()
        zenoh.subscribeDimos("log", (event: { run?: string }) => {
            const { runId } = this.state.get()
            // another run's log: a newer run may have started
            if (event?.run && event.run !== "launch" && event.run !== runId) {
                this.#restart()
            } else if (event?.run === runId) {
                this.refresh()
            }
        })
        zenoh.subscribeDimos("launch", () => this.#restart())
        zenoh.onReconnect(() => this.refresh())
        setInterval(() => this.#checkActive(), ACTIVE_POLL_MS)
        this.refresh()
    }

    /** Marks every record up to now as seen (the Logs panel is showing them). */
    markSeen() {
        const { records, seen, runId } = this.state.get()
        const newest = records.at(-1)?.timestamp ?? ""
        if (newest > seen) {
            this.state.update({ seen: newest })
            if (runId) {
                writeLocal(SEEN_KEY, { runId, seen: newest })
            }
        }
    }

    #restart() {
        this.#offset = null
        this.refresh()
    }

    /** Asks for what's new (coalesced: a call while one is in flight runs once more after it). */
    refresh(): Promise<void> {
        if (this.#pending) {
            this.#again = true
            return this.#pending
        }
        this.#pending = this.#load().finally(() => {
            this.#pending = null
            if (this.#again) {
                this.#again = false
                this.refresh()
            }
        })
        return this.#pending
    }

    async #checkActive() {
        try {
            const active = await (await fetch(gatewayUrl("active"))).json()
            const { runId, running } = this.state.get()
            const now = !!active.running && active.runId === runId
            if (active.running && active.runId && active.runId !== runId) {
                this.#restart()
            } else if (now !== running) {
                this.state.update({ running: now })
            }
        } catch {
            // no gateway: keep what we knew
        }
    }

    async #load() {
        const first = this.#offset === null
        const path = first ? `history/latest/logs?limit=${FIRST_READ}` : `history/${encodeURIComponent(this.state.get().runId!)}/logs?after=${this.#offset}`
        let page: RunLog
        try {
            const response = await fetch(gatewayUrl(path))
            if (response.status === 404) {
                this.state.update({ runId: null, running: false, records: [], loggers: [], note: "No dimos run has a log yet." })
                return
            }
            if (!response.ok) {
                throw new Error(String(response.status))
            }
            page = await response.json()
        } catch {
            if (first) {
                this.state.update({ note: "No dimos gateway here (Desktop's /gateways/dimos/): no logs to show." })
            }
            return
        }
        const records = page.records.map((record) => ({ ...record, logger: record.logger ?? "" }))
        const current = this.state.get()
        if (first || page.runId !== current.runId) {
            const saved = readLocal<{ runId?: string; seen?: string }>(SEEN_KEY, {})
            const loggers = [...new Set([...page.loggers, ...records.map((record) => record.logger)])].filter(Boolean).sort()
            this.state.set({ runId: page.runId, running: false, records: appendRecords([], records), loggers, seen: saved.runId === page.runId ? saved.seen ?? "" : "", note: null })
            this.#checkActive()
        } else if (records.length) {
            const known = new Set(current.loggers)
            const added = records.map((record) => record.logger).filter((name) => name && !known.has(name))
            this.state.update({ records: appendRecords(current.records, records), loggers: added.length ? [...new Set([...current.loggers, ...added])].sort() : current.loggers })
        }
        this.#offset = page.offset
        // nothing tells this page when an unwatched log grows: ask again on a timer
        if (page.watched === false && !this.#poll) {
            this.#poll = setInterval(() => this.refresh(), UNWATCHED_POLL_MS)
        } else if (page.watched !== false && this.#poll) {
            clearInterval(this.#poll)
            this.#poll = null
        }
    }
}

export const logFeed = new LogFeed()
