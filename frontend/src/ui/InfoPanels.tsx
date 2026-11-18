// The panels that are lists and forms: Settings, TF and Logs (joint control is in the 3D view), each in the shared frame (ui/Panel.tsx), its
// body scrolling inside it.
import type { ViewerApp } from "../core/app.ts"
import { useStore } from "../core/store.ts"
import { Panel } from "./Panel.tsx"
import { SettingsPanel } from "./SettingsPanel.tsx"
import { TfPanel } from "./TfPanel.tsx"
import { LogsPanel } from "./LogsPanel.tsx"
import { panelTitle } from "./commands.ts"

export function InfoPanels({ app }: { app: ViewerApp }) {
    const { issues } = useStore(app.tfIssues)
    return (
        <>
            <Panel id="settings" title={panelTitle("settings")} icon="settings" bodyClassName="panel-body" testid="settings-panel">
                <SettingsPanel app={app} />
            </Panel>
            <Panel id="tf" title={panelTitle("tf")} icon="tree" info={issues.length ? `${issues.length} issue${issues.length === 1 ? "" : "s"}` : undefined} className={issues.length ? "has-issues" : ""} bodyClassName="panel-body">
                <TfPanel app={app} />
            </Panel>
            <Panel id="logs" title={panelTitle("logs")} icon="logs" bodyClassName="logs-body" testid="logs">
                <LogsPanel />
            </Panel>
        </>
    )
}
