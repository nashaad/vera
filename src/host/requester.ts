export interface HostRequester {
    readonly pid: number;
    readonly client_kind: string;
    readonly command?: string;
    readonly session_id?: string;
    readonly session_name?: string;
}

export const HOST_REQUESTER_KIND_ENV = "VERA_HOST_REQUESTER_KIND";

export interface RequesterSession {
    readonly id?: string;
    readonly name?: string;
}

export function hostRequester(clientKind: string, command: string, session?: RequesterSession): HostRequester {
    const usable = (value: string | undefined): value is string =>
        value !== undefined && value.length > 0 && value.length <= 256 && !value.includes("\0");
    return {
        pid: process.pid,
        client_kind: clientKind,
        command,
        ...(usable(session?.id) ? { session_id: session.id } : {}),
        ...(usable(session?.name) ? { session_name: session.name } : {}),
    };
}

export function cliHostRequester(command: string): HostRequester {
    return hostRequester(process.env[HOST_REQUESTER_KIND_ENV] === "desktop" ? "desktop" : "cli", command);
}
