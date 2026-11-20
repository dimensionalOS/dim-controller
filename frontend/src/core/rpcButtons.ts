// The running blueprint's zero-argument RPCs as action bar buttons: Desktop's GET /gateways/dimos/active/modules (each
// instance's RPCs, params from the gateway's last scan), read again whenever what's running changes (core/runs.ts), and
// a click is the gateway's POST /gateways/dimos/active/modules/{id}/rpcs/{name} (RPCs only go through the dimos gateway).
import { Store } from "./store.ts"
import type { RunResult } from "./actionButtons.ts"
import type { RunWatch } from "./runs.ts"

export interface RpcButton {
    /** the gateway's instance id */
    module: string
    name: string
    /** the name as a label: stop_movement → Stop Movement */
    label: string
    doc: string
}

type LiveModule = { id: string; rpcs?: { name: string; doc?: string; params?: unknown[] | null; return_type?: string | null }[] }

/** what it returns, as the order the bar lists it in: nothing, then a bool, then anything else (or not annotated) */
const returnRank = (returnType: string | null | undefined) => returnType === "None" ? 0 : returnType === "bool" ? 1 : 2

export const rpcButtons = new Store<{ buttons: RpcButton[] }>({ buttons: [] })

const gatewayUrl = (path: string) => new URL(`../../gateways/dimos/${path}`, location.href)

export const rpcLabel = (name: string) => name.split("_").filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(" ")

/** Every RPC the scan saw take no parameters (params null = not scanned: its arguments are unknown, so no button), those
 * returning nothing first, then a bool, then the rest. */
export function zeroArgRpcs(modules: LiveModule[]): RpcButton[] {
    return modules
        .flatMap((module) =>
            (module.rpcs ?? [])
                .filter((rpc) => Array.isArray(rpc.params) && rpc.params.length === 0)
                .map((rpc) => ({ rank: returnRank(rpc.return_type), button: { module: module.id, name: rpc.name, label: rpcLabel(rpc.name), doc: rpc.doc ?? "" } }))
        )
        .sort((a, b) => a.rank - b.rank)
        .map(({ button }) => button)
}

async function load() {
    try {
        const response = await fetch(gatewayUrl("active/modules"))
        const body = response.ok ? await response.json() : {}
        rpcButtons.set({ buttons: zeroArgRpcs(body.modules ?? []) })
    } catch {
        // no dimos gateway here (dev server, remote robot), or nothing running: no RPC buttons
        rpcButtons.set({ buttons: [] })
    }
}

/** Follows what's running: the buttons are read again on every change of the running blueprints. */
export function watchRpcButtons(runs: RunWatch): () => void {
    let running = ""
    const check = () => {
        const state = runs.state.get()
        const now = `${state.running.join(",")}|${state.starting ?? ""}`
        if (now !== running) {
            running = now
            load()
        }
    }
    check()
    return runs.state.subscribe(check)
}

export async function callRpc(button: RpcButton): Promise<RunResult> {
    const started = performance.now()
    const ms = () => Math.round(performance.now() - started)
    try {
        const response = await fetch(gatewayUrl(`active/modules/${encodeURIComponent(button.module)}/rpcs/${encodeURIComponent(button.name)}`), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ args: [], kwargs: {} }),
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok) {
            return { ok: false, exitCode: null, stdout: "", stderr: "", ms: ms(), error: body.error ?? body.detail ?? `${response.status}` }
        }
        const result = body.result === null || body.result === undefined ? "" : typeof body.result === "string" ? body.result : JSON.stringify(body.result, null, 2)
        return { ok: !!body.ok, exitCode: null, stdout: result, stderr: body.error ?? "", ms: ms(), error: body.ok ? undefined : body.error ?? "failed" }
    } catch (error) {
        return { ok: false, exitCode: null, stdout: "", stderr: "", ms: ms(), error: (error as Error).message }
    }
}
