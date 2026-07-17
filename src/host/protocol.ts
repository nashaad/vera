import { createConnection, type Socket } from "node:net";

export interface HostIdentity {
    readonly pid: number;
    readonly started_at: string;
}

export interface HostIdentityRequest {
    readonly type: "host_identity";
}

export interface HostIdentityResponse {
    readonly type: "host_identity";
    readonly pid: number;
    readonly started_at: string;
}

export type HostRequest = HostIdentityRequest;
export type HostResponse = HostIdentityResponse;

export function parseHostRequest(source: string): HostRequest | undefined {
    const value = parseJsonObject(source);
    return value?.type === "host_identity"
        ? { type: "host_identity" }
        : undefined;
}

export function encodeHostResponse(response: HostResponse): string {
    return `${JSON.stringify(response)}\n`;
}

export function requestHostIdentity(
    socketPath: string,
): Promise<HostIdentity | undefined> {
    return new Promise((resolve) => {
        let socket: Socket;
        try {
            socket = createConnection(socketPath);
        } catch {
            resolve(undefined);
            return;
        }
        let finished = false;
        let buffered = "";
        const deadline = setTimeout(() => finish(undefined), 250);
        const finish = (identity: HostIdentity | undefined): void => {
            if (finished) {
                return;
            }
            finished = true;
            clearTimeout(deadline);
            socket.destroy();
            resolve(identity);
        };
        socket.setEncoding("utf8");
        socket.once("connect", () => {
            socket.write(`${JSON.stringify({ type: "host_identity" })}\n`);
        });
        socket.on("data", (chunk: string) => {
            buffered += chunk;
            if (buffered.length > 4_096) {
                finish(undefined);
                return;
            }
            const newline = buffered.indexOf("\n");
            if (newline !== -1) {
                finish(parseHostIdentity(buffered.slice(0, newline)));
            }
        });
        socket.once("error", () => finish(undefined));
        socket.once("end", () => finish(undefined));
        socket.once("close", () => finish(undefined));
    });
}

function parseHostIdentity(source: string): HostIdentity | undefined {
    const response = parseJsonObject(source);
    if (
        response?.type !== "host_identity"
        || !Number.isInteger(response.pid)
        || (response.pid as number) <= 0
        || typeof response.started_at !== "string"
        || Number.isNaN(Date.parse(response.started_at))
    ) {
        return undefined;
    }
    return {
        pid: response.pid as number,
        started_at: response.started_at,
    };
}

function parseJsonObject(source: string): Record<string, unknown> | undefined {
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        return undefined;
    }
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}
