// The 3D view menu's layers past its point clouds (ui/ScenePanel.tsx): every other drawable topic, grouped by layer
// type: a switch (on = subscribed), live info or the problem, and the layer's own settings behind a disclosure.
import { PLACEMENTS, type Placement } from "../core/layers/placement.ts"
import { createContext, type CSSProperties, type ReactNode, useContext, useId, useMemo, useState } from "react"
import { hashHue } from "../core/hashHue.ts"
import type { ViewerApp } from "../core/app.ts"
import type { LayerEntry } from "../core/layers/manager.ts"
import { Store, useStore } from "../core/store.ts"
import { Field, Segmented, Toggle } from "dimos-react"
import { Icon } from "./icons.tsx"
import { bandwidthOverrides, setOverride } from "../core/bandwidth.ts"
import { readLocal, writeLocal } from "../core/videoQuality.ts"
import { matchesQuery } from "../core/topicFilter.ts"

/** layer group label → collapsed; per viewer */
const COLLAPSED_KEY = "lv.layers.collapsed"

/** Which row's settings are open among its siblings: opening one closes the others. A row's own settings hold a fresh
 * one, so a nested row (a URDF group under its URDF) closes only its siblings, never its parent. */
const OpenRow = createContext(new Store<{ id: string | null }>({ id: null }))

/** One switchable row: a toggle, the name (and type), what's below it (status), and settings behind a disclosure. */
export function Row({ value, onChange, name, type, kind, title, className = "", testKey, below, extra, children }: {
    value: boolean
    onChange: (on: boolean) => void
    name: string
    type?: string
    /** the message type: colors the switch, the same hue for every stream of that type (core/hashHue.ts) */
    kind?: string
    title?: string
    className?: string
    testKey?: string
    below?: ReactNode
    /** controls on the row itself, after its name */
    extra?: ReactNode
    children?: ReactNode
}) {
    const id = useId()
    const siblings = useContext(OpenRow)
    const open = useStore(siblings).id === id
    const setOpen = (on: boolean) => siblings.set({ id: on ? id : null })
    const childRows = useMemo(() => new Store<{ id: string | null }>({ id: null }), [])
    return (
        <div className={`layer-row ${kind ? "kinded" : ""} ${value ? "on" : ""} ${open && children ? "open" : ""} ${className}`} data-key={testKey} style={kind ? { "--kind-hue": hashHue(kind) } as CSSProperties : undefined}>
            <div className="layer-line">
                <Toggle aria-label={name} value={value} onChange={onChange} />
                <button type="button" className="layer-name" onClick={() => setOpen(!open)} disabled={!children} title={title} aria-expanded={children ? open : undefined}>
                    <span className="topic-name">{name}</span>
                    {type && <span className="topic-type">{type}</span>}
                    {children && <span className={`chevron ${open ? "open" : ""}`}><Icon name="chevron-right" size={14} /></span>}
                </button>
                {extra}
            </div>
            {below}
            {open && children && <div className="layer-settings"><OpenRow.Provider value={childRows}>{children}</OpenRow.Provider></div>}
        </div>
    )
}

/** A layer's live info or problem under its row, or that it's paused in Network → Bandwidth Consumers (on, but nothing subscribed). */
export function LayerStatusLine({ entry }: { entry: LayerEntry }) {
    const paused = !!useStore(bandwidthOverrides)[entry.topic.key]?.paused
    if (!entry.enabled) {
        return null
    }
    if (paused) {
        return (
            <div className="layer-status paused" data-testid="layer-paused">
                paused in Network · <button type="button" className="net-link" onClick={() => setOverride(entry.topic.key, { paused: undefined })}>resume</button>
            </div>
        )
    }
    const text = entry.status.problem ?? entry.status.info
    return text ? <div className={`layer-status ${entry.status.problem ? "problem" : ""}`}>{text}</div> : null
}

/** Where the layer's data is drawn (core/layers/placement.ts): every layer type with data of its own has it. */
export function PlacementField({ entry }: { entry: LayerEntry }) {
    const settings = entry.settings as Store<{ placement?: Placement }>
    const { placement } = useStore(settings)
    const [help, setHelp] = useState(false)
    const label = (
        <>
            Placement
            <button type="button" className="help-dot" aria-label="what placement means" aria-expanded={help} onClick={(event) => { event.preventDefault(); setHelp(!help) }}>?</button>
        </>
    )
    const hint = help
        ? "This is a really minor visual optimization. Point clouds should be Instant: they get their position from TF, but only at the instant they were taken, so they don't move with the robot. Things like limbs are Attached to TF: they move with the robot."
        : undefined
    return (
        <Field inline className="placement-field" label={label} hint={hint}>
            <Segmented size="sm" items={PLACEMENTS} value={placement ?? "attached"} onChange={(next: Placement) => settings.update({ placement: next })} label="placement" />
        </Field>
    )
}

function LayerRow({ app, entry }: { app: ViewerApp; entry: LayerEntry }) {
    const Settings = entry.type.Settings
    const RowControls = entry.type.RowControls
    return (
        <Row
            value={entry.enabled}
            onChange={(enabled) => app.layers.setEnabled(entry.topic.key, enabled)}
            name={entry.topic.name}
            type={entry.topic.type.split(".")[1]}
            kind={entry.topic.type}
            title={entry.topic.key}
            className={entry.status.problem ? "problem" : ""}
            testKey={entry.topic.key}
            below={<LayerStatusLine entry={entry} />}
        >
            {(RowControls || Settings || entry.type.placement !== false) && (
                <>
                    {RowControls && <RowControls settings={entry.settings} topic={entry.topic} />}
                    {Settings && <Settings settings={entry.settings} topic={entry.topic} />}
                    {entry.type.placement !== false && <PlacementField entry={entry} />}
                </>
            )}
        </Row>
    )
}

/** Which group titles are folded, remembered per viewer (lv.layers.collapsed); `toggle(label)` folds or unfolds one.
 * Each list using it draws its own groups, so a toggle merges into what's saved rather than this one's copy. */
export function useCollapsedGroups(): { collapsed: Record<string, boolean>; toggle: (label: string) => void } {
    const [collapsed, setCollapsed] = useState(() => readLocal<Record<string, boolean>>(COLLAPSED_KEY, {}))
    const toggle = (label: string) => {
        const next = { ...readLocal<Record<string, boolean>>(COLLAPSED_KEY, {}), [label]: !collapsed[label] }
        setCollapsed(next)
        writeLocal(COLLAPSED_KEY, next)
    }
    return { collapsed, toggle }
}

/** A group's title: a click folds or unfolds it; folded, it shows how many it holds. */
export function GroupTitle({ label, count, collapsed, onToggle }: { label: string; count: number; collapsed: boolean; onToggle: () => void }) {
    return (
        <button type="button" className="quality-title layer-group-title" aria-expanded={!collapsed} onClick={onToggle}>
            <span className={`chevron ${collapsed ? "" : "open"}`}><Icon name="chevron-right" size={12} /></span>
            {label}
            {collapsed && <span className="layer-group-count">{count}</span>}
        </button>
    )
}

/** @param heads controls at the top of a group, by its label (the group shows even with no layers in it)
 * @param lead group labels drawn first, in this order (when they have layers)
 * @param query the menu's search: only the matching topics (core/topicFilter.ts), their groups unfolded */
export function LayerList({ app, skip, heads = {}, lead = [], query = "" }: { app: ViewerApp; skip: (entry: LayerEntry) => boolean; heads?: Record<string, ReactNode>; lead?: string[]; query?: string }) {
    const all = useStore(app.layers.entries).list
    const searching = query.trim() !== ""
    const list = all.filter((entry) => !skip(entry) && (!searching || matchesQuery(query, entry.topic.name, entry.topic.type, entry.type.label)))
    const connection = useStore(app.connection.status)
    const groups = new Map<string, LayerEntry[]>(Object.keys(heads).filter((label) => !searching || matchesQuery(query, label)).map((label) => [label, []]))
    for (const entry of list) {
        groups.set(entry.type.label, [...(groups.get(entry.type.label) ?? []), entry])
    }
    const ordered = [...lead.filter((label) => groups.has(label)).map((label) => [label, groups.get(label)!] as const), ...[...groups].filter(([label]) => !lead.includes(label))]
    const { collapsed: folded, toggle } = useCollapsedGroups()
    const collapsed = searching ? {} : folded
    const drawn = new Set(all.map((entry) => entry.topic.key))
    const other = connection.topics.filter((topic) => !drawn.has(topic.key) && (!searching || matchesQuery(query, topic.name, topic.type)))
    return (
        <div className="layers">
            {ordered.map(([label, entries]) => (
                <section key={label} className={`layer-group ${collapsed[label] ? "collapsed" : ""}`}>
                    <GroupTitle label={label} count={entries.length} collapsed={!!collapsed[label]} onToggle={() => toggle(label)} />
                    {!collapsed[label] && heads[label]}
                    {!collapsed[label] && entries.map((entry) => {
                        const Rows = entry.type.Rows
                        return Rows ? <Rows key={entry.topic.key} entry={entry} layers={app.layers} /> : <LayerRow key={entry.topic.key} app={app} entry={entry} />
                    })}
                </section>
            ))}
            {other.length > 0 && (
                <details className="layer-group other-topics">
                    <summary>{other.length} other topics (not drawn)</summary>
                    {other.map((topic) => <div key={topic.key} className="other-topic"><span>{topic.name}</span><span className="topic-type">{topic.type}</span></div>)}
                </details>
            )}
        </div>
    )
}
