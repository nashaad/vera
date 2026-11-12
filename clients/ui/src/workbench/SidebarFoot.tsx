import { LAYOUT_COMMANDS } from "../commands/layout-commands.ts";
import { NAVIGATION_COMMANDS } from "../commands/navigation-commands.ts";
import { GearIcon, LaptopIcon, PanelIcon, PlayIcon } from "../components/Icons.tsx";
import { useRouter } from "../pages/router.tsx";
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

function TourButton() {
    const { route, navigate } = useRouter();
    return (
        <button
            type="button"
            className="header-button"
            aria-label="Tour"
            title="Tour: every screen, sheet and session state"
            data-page="tour"
            data-lit={route.kind === "tour"}
            onClick={() => navigate({ kind: "tour" })}
        >
            <PlayIcon />
        </button>
    );
}

function DevicesButton() {
    const { route, navigate } = useRouter();
    return (
        <button
            type="button"
            className="header-button"
            aria-label="Devices"
            title="Devices"
            data-page="devices"
            data-lit={route.kind === "devices"}
            onClick={() => navigate({ kind: "devices" })}
        >
            <LaptopIcon />
        </button>
    );
}

function SettingsButton() {
    const { run } = useWorkbench();
    const { route } = useRouter();
    const hint = shortcutLabel(NAVIGATION_COMMANDS.settings, window.veraDesktop?.platform ?? "");
    return (
        <button
            type="button"
            className="header-button"
            aria-label="Settings"
            title={hint === "" ? "Settings" : `Settings (${hint})`}
            data-page="settings"
            data-lit={route.kind === "settings"}
            onClick={() => run(NAVIGATION_COMMANDS.settings)}
        >
            <GearIcon />
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

// The sidebar's bottom row: the connection to the host, the panel toggle, Tour, Devices and Settings.
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
            <TourButton />
            <DevicesButton />
            <SettingsButton />
        </footer>
    );
}
