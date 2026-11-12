import { phaseLabel, toneOf, buildLabel, type UiState } from "../state/connection.ts";
import type { ThemeName } from "../theme/tokens.ts";
import { RemoteIcon } from "./Icons.tsx";
import { ThemePicker } from "./ThemePicker.tsx";

export interface StatusBarProps {
    readonly state: UiState;
    readonly theme: ThemeName;
    readonly themeNames: readonly ThemeName[];
    readonly onThemeChange: (name: ThemeName) => void;
}

export function StatusBar({ state, theme, themeNames, onThemeChange }: StatusBarProps) {
    const protocol = state.identity?.protocol_version;
    const home = state.ready?.home;
    return (
        <footer className="statusbar" aria-label="Status">
            <span className="statusbar-remote" data-tone={toneOf(state)} data-item="state">
                <RemoteIcon />
                {phaseLabel(state)}
            </span>
            {state.ready !== undefined ? (
                <span className="statusbar-item" data-item="host">host {buildLabel(state)}</span>
            ) : null}
            {protocol !== undefined ? (
                <span className="statusbar-item" data-item="protocol">protocol v{protocol}</span>
            ) : null}
            {state.sessions !== undefined ? (
                <span className="statusbar-item" data-item="sessions">
                    {state.sessions} {state.sessions === 1 ? "session" : "sessions"}
                </span>
            ) : null}
            <span className="spacer" />
            {home !== undefined ? (
                <span className="statusbar-item statusbar-home" data-item="home" title={home}>
                    {home}
                </span>
            ) : null}
            <ThemePicker value={theme} names={themeNames} onChange={onThemeChange} />
        </footer>
    );
}
