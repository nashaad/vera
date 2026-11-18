import { buildLabel, phaseLabel, type UiState } from "../state/connection.ts";
import type { SessionRow } from "../protocol/sessions.ts";

export type DeviceHealth = "ok" | "warn" | "fail";

// The name for the machine this window runs on; the host is the only device it can describe.
export function deviceLabel(platform: string): string {
    if (platform === "darwin") return "This Mac";
    if (platform === "win32") return "This PC";
    return "This computer";
}

export function deviceHealth(state: UiState): DeviceHealth {
    if (state.phase === "attached") return "ok";
    if (state.phase === "starting" || state.phase === "waiting") return "warn";
    return "fail";
}

export function deviceDetail(state: UiState): string {
    if (state.phase !== "attached") return phaseLabel(state);
    const parts = ["Host running"];
    if (state.ready?.buildId) parts.push(`build ${buildLabel(state)}`);
    if (state.identity !== undefined) parts.push(`protocol v${state.identity.protocol_version}`);
    return parts.join(" · ");
}

// Newest first. A row with no time sorts last.
export function newestRows(rows: readonly SessionRow[]): readonly SessionRow[] {
    return [...rows].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
}

export function sessionCountLabel(count: number): string {
    return `${count} session${count === 1 ? "" : "s"}`;
}
