import { useState } from "react";

import { ArrowLeftIcon, ChevronRightIcon, LaptopIcon } from "../components/Icons.tsx";
import type { DesktopBridge } from "../protocol/bridge.ts";
import { rowFolderName, rowFolderPath } from "../protocol/sessionGroups.ts";
import { relativeTime, type SessionRow } from "../protocol/sessions.ts";
import { phaseLabel, type UiState } from "../state/connection.ts";
import { useViewEnvironment } from "../views/env.tsx";
import { Page } from "./Page.tsx";
import { deviceDetail, deviceHealth, deviceLabel, newestRows, sessionCountLabel } from "./devices.ts";
import { useRouter } from "./router.tsx";
import { statusPhrase } from "./WorkspacePage.tsx";

const SESSION_LIST_CAP = 20;

export function DevicesPage() {
    const { connection } = useViewEnvironment();
    const [opened, setOpened] = useState(false);
    if (opened) {
        return (
            <div className="page-scroll">
                <div className="page">
                    <div className="page-inner">
                        <DeviceDetail state={connection} onBack={() => setOpened(false)} />
                    </div>
                </div>
            </div>
        );
    }
    return (
        <Page title="Devices" lede="Machines this client can reach. A session runs on one of them, and stays there." Icon={LaptopIcon}>
            <DeviceList state={connection} onOpen={() => setOpened(true)} />
        </Page>
    );
}

interface DeviceListProps {
    readonly state: UiState;
    readonly onOpen: () => void;
}

function DeviceList({ state, onOpen }: DeviceListProps) {
    const platform = window.veraDesktop?.platform ?? "";
    return (
        <>
            <ul className="list">
                <li>
                    <button type="button" className="list-row" data-device="local" onClick={onOpen}>
                        <LaptopIcon className="list-row-glyph" />
                        <span className="list-row-body">
                            <span className="list-row-name">
                                <span className="list-row-title">{deviceLabel(platform)}</span>
                                <span className="health-dot" data-health={deviceHealth(state)} aria-hidden="true" />
                                <span className="list-row-state">{stateLabel(state)}</span>
                            </span>
                            <span className="list-row-detail">{deviceDetail(state)}</span>
                        </span>
                        {state.sessions === undefined ? null : <span className="badge">{sessionCountLabel(state.sessions)}</span>}
                        <ChevronRightIcon className="list-row-go" />
                    </button>
                </li>
            </ul>
            <p className="section-note">Other machines are not listed. This host does not pair with other devices.</p>
        </>
    );
}

interface DeviceDetailProps {
    readonly state: UiState;
    readonly onBack: () => void;
}

function DeviceDetail({ state, onBack }: DeviceDetailProps) {
    const { navigate } = useRouter();
    const bridge = window.veraDesktop as DesktopBridge | undefined;
    const platform = window.veraDesktop?.platform ?? "";
    const attached = state.phase === "attached";
    const rows = state.sessionRows ?? [];
    const shown = newestRows(rows).slice(0, SESSION_LIST_CAP);
    const now = Date.now();
    return (
        <>
            <button type="button" className="ghost-btn device-back" onClick={onBack}>
                <ArrowLeftIcon />
                Devices
            </button>
            <div className="device-hero">
                <span className="device-glyph" data-health={deviceHealth(state)}>
                    <LaptopIcon />
                </span>
                <div className="device-name">{deviceLabel(platform)}</div>
                <div className="device-state">{stateLabel(state)}</div>
                {state.ready === undefined ? null : <div className="device-hint"><code>{state.ready.home}</code></div>}
                {attached ? null : (
                    <button type="button" className="solid-btn" onClick={() => bridge?.reconnect()}>Reconnect</button>
                )}
            </div>
            <h2 className="section-title">
                Sessions here <span className="section-count">{state.sessions ?? rows.length}</span>
            </h2>
            {shown.length === 0 ? <p className="section-note">No session runs on this machine yet.</p> : null}
            <ul className="list">
                {shown.map((row) => (
                    <li key={row.id}>
                        <SessionListRow row={row} now={now} onOpen={() => navigate({ kind: "session", agentId: row.id, title: row.name })} />
                    </li>
                ))}
            </ul>
            {rows.length > SESSION_LIST_CAP ? <p className="section-note">Showing the newest {SESSION_LIST_CAP}.</p> : null}
        </>
    );
}

interface SessionListRowProps {
    readonly row: SessionRow;
    readonly now: number;
    readonly onOpen: () => void;
}

function SessionListRow({ row, now, onOpen }: SessionListRowProps) {
    return (
        <button type="button" className="list-row" data-session={row.id} data-status={row.status} onClick={onOpen}>
            <span className="session-dot" data-running={row.status === "working" || row.status === "waiting"} aria-hidden="true" />
            <span className="list-row-body">
                <span className="list-row-name">
                    <span className="list-row-title">{row.name}</span>
                </span>
                <span className="list-row-detail" title={rowFolderPath(row)}>{rowFolderName(row)} · {statusPhrase(row.status)}</span>
            </span>
            <span className="list-row-age">{relativeTime(row.updatedAt, now)}</span>
            <ChevronRightIcon className="list-row-go" />
        </button>
    );
}

function stateLabel(state: UiState): string {
    return state.phase === "attached" ? "Connected" : phaseLabel(state);
}
