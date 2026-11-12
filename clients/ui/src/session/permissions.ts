// A session's approval mode and what it has already allowed, read from `permissions` updates,
// and the commands that change them.

export interface StandingPermission {
    readonly id: string;
    readonly description: string;
}

export interface ApprovalState {
    // The request this reply answers; a reply to a read reports pending whenever a turn is running.
    readonly requestId?: string;
    readonly mode: string;
    // Set while the change waits for the running turn to end.
    readonly pending: boolean;
    // "user" when someone chose the mode for this session, "agent-default" when it came from the agent's definition.
    readonly origin?: "user" | "agent-default";
    readonly modes: readonly string[];
    // Allowed for this session through Allow similar.
    readonly grants: readonly StandingPermission[];
    // Allowed in every session through Always.
    readonly preferences: readonly StandingPermission[];
    readonly warning?: string;
}

export interface ModeOption {
    readonly mode: string;
    readonly label: string;
    readonly description: string;
    readonly warn: boolean;
}

export const BUILT_IN_MODES: readonly ModeOption[] = [
    { mode: "ask", label: "Ask for approval", description: "Ask before every command and every change outside the read-only tools", warn: false },
    { mode: "auto", label: "Approve for me", description: "A reviewer clears the safe calls; you decide the rest", warn: false },
    { mode: "readonly", label: "Read only", description: "Allow reads and deny every change", warn: false },
    { mode: "full_access", label: "Full access", description: "Run anything your user account can, with no approvals", warn: true },
];

export function modeLabel(mode: string): string {
    return BUILT_IN_MODES.find((option) => option.mode === mode)?.label ?? mode.replaceAll("_", " ");
}

// The built-in modes first, then any custom mode the session offers.
export function modeOptions(modes: readonly string[]): readonly ModeOption[] {
    const custom = modes
        .filter((mode) => !BUILT_IN_MODES.some((option) => option.mode === mode))
        .map((mode) => ({ mode, label: modeLabel(mode), description: "A mode defined in this home", warn: false }));
    return [...BUILT_IN_MODES, ...custom];
}

type Fields = Record<string, unknown>;

export function parsePermissions(value: Fields): ApprovalState | undefined {
    const mode = str(value.mode);
    if (mode === undefined || typeof value.pending !== "boolean") return undefined;
    const inspection = isRecord(value.inspection) ? value.inspection : {};
    const modes = Array.isArray(inspection.availableModes)
        ? inspection.availableModes.filter((entry): entry is string => typeof entry === "string")
        : [];
    const origin = value.origin === "user" || value.origin === "agent-default" ? value.origin : undefined;
    const warning = str(value.warning);
    const requestId = str(value.requestId);
    return {
        ...(requestId === undefined ? {} : { requestId }),
        mode,
        pending: value.pending,
        ...(origin === undefined ? {} : { origin }),
        modes,
        grants: standing(inspection.activeGrants),
        preferences: standing(inspection.activePreferences),
        ...(warning === undefined ? {} : { warning }),
    };
}

function standing(value: unknown): readonly StandingPermission[] {
    if (!Array.isArray(value)) return [];
    const entries: StandingPermission[] = [];
    for (const raw of value) {
        if (!isRecord(raw)) continue;
        const id = str(raw.id);
        if (id === undefined) continue;
        entries.push({ id, description: describePredicate(isRecord(raw.when) ? raw.when : {}) });
    }
    return entries;
}

// Words for what a grant or preference matches, in the order the terminal shows them.
export function describePredicate(when: Fields): string {
    const executable = str(when.executable);
    const parts = [
        str(when.verb),
        str(when.operation),
        str(when.host),
        executable,
        executable === undefined ? str(when.tool) : undefined,
        str(when.pathGlob),
        str(when.path),
        str(when.scope),
    ].filter((part): part is string => part !== undefined);
    return parts.length === 0 ? "similar actions" : parts.join(" ");
}

export function getPermissionsCommand(requestId: string): string {
    return line({ type: "get_permissions", requestId });
}

// Changes this session only.
export function sessionModeCommand(requestId: string, mode: string): string {
    return line({ type: "update_session_permission_mode", requestId, mode });
}

// Changes this session and the host default that new sessions start in.
export function defaultModeCommand(requestId: string, mode: string): string {
    return line({ type: "update_permissions", requestId, mode });
}

export function removeGrantCommand(requestId: string, id: string): string {
    return line({ type: "remove_permission_grant", requestId, id });
}

export function removePreferenceCommand(requestId: string, id: string): string {
    return line({ type: "remove_permission_preference", requestId, id });
}

function line(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
}

function str(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Fields {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
