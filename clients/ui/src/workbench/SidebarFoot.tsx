import { LAYOUT_COMMANDS } from "../commands/layout-commands.ts";
import { PanelIcon } from "../components/Icons.tsx";
import { buildLabel, phaseLabel, toneOf, type UiState } from "../state/connection.ts";
import { useViewEnvironment } from "../views/env.tsx";
import { useIsShown, useWorkbench } from "./context.tsx";
import { shortcutLabel } from "./hints.ts";

const PANEL_TOGGLE = "Toggle Panel";

function PanelToggle() {
    const { run } = useWorkbench();
    const shown = useIsShown("panel");
    const hint = shortcutLabel(LAYOUT_COMMANDS.togglePanel, window.veraDesktop?.platform ?? "");
    return (
        <button
            type="button"
            className="header-button"
            aria-label={PANEL_TOGGLE}
            aria-pressed={shown}
            title={hint === "" ? PANEL_TOGGLE : `${PANEL_TOGGLE} (${hint})`}
            data-toggle="panel"
            onClick={() => run(LAYOUT_COMMANDS.togglePanel)}
        >
            <PanelIcon />
        </button>
    );
}

function hostTitle(state: UiState): string {
    const lines = [`Host build ${state.ready?.buildId ?? "unknown"}`];
    if (state.identity !== undefined) {
        lines.push(`Protocol v${state.identity.protocol_version}`, `Process ${state.identity.pid}`);
    }
    if (state.ready !== undefined) lines.push(state.ready.home);
    return lines.join("\n");
}

// The sidebar's bottom row: the connection to the host, then window controls.
export function SidebarFoot() {
    const { connection: state } = useViewEnvironment();
    return (
        <footer className="sidebar-foot" aria-label="Status">
            <span
                className="sidebar-foot-state"
                data-item="state"
                data-tone={toneOf(state)}
                title={state.ready === undefined ? undefined : hostTitle(state)}
            >
                <span className="sidebar-foot-dot" aria-hidden="true" />
                {phaseLabel(state)}
                {state.ready !== undefined ? (
                    <span className="sidebar-foot-build" data-item="host" data-protocol={state.identity?.protocol_version}>
                        {" · "}{buildLabel(state)}
                    </span>
                ) : null}
            </span>
            <PanelToggle />
        </footer>
    );
}
