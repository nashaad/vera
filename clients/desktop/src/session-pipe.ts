import { createConnection, type Socket } from "node:net";
import { isAbsolute } from "node:path";

import { HOST_CAPABILITY_AGENT_HISTORY_PAGING } from "../../../src/host/capabilities.ts";
import { MAX_FRAME_BYTES } from "../../../src/host/connection.ts";
import type { DesktopEvent } from "../../ui/src/protocol/bridge.ts";
import { describeFailure } from "./host-pipe.ts";

const MAX_REDIRECTS = 1;
const CLOSED_BY_HOST = "The host closed this session.";
const MOVED_TWICE = "The host moved this session more than once.";
const DETACH_LINE = `${JSON.stringify({ type: "detach" })}\n`;

interface Watch {
    readonly agentId: string;
    readonly socket: Socket;
    readonly generation: number;
    readonly redirects: number;
    connected: boolean;
    finished: boolean;
}

// One watch connection for the session being viewed. Replacing or detaching it
// retires its generation first, so the old socket's close or error emits nothing.
export class SessionPipe {
    private socketPath: string | undefined;
    private watchState: Watch | undefined;
    private generation = 0;

    constructor(private readonly emit: (event: DesktopEvent) => void) {}

    connect(socketPath: string): void {
        this.stop();
        this.socketPath = socketPath;
    }

    close(): void {
        this.stop();
        this.socketPath = undefined;
    }

    watch(agentId: string): void {
        this.stop();
        const socketPath = this.socketPath;
        if (socketPath === undefined) {
            this.emit({ type: "session_closed", agentId, reason: "The host is not running." });
            return;
        }
        this.open(agentId, socketPath, 0);
    }

    send(text: string): void {
        const state = this.watchState;
        if (state === undefined || !state.connected) return;
        state.socket.write(text);
    }

    unwatch(): void {
        const state = this.watchState;
        if (state === undefined) return;
        this.generation += 1;
        this.watchState = undefined;
        if (state.connected) {
            state.socket.write(DETACH_LINE);
            state.socket.end();
        } else {
            state.socket.destroy();
        }
    }

    private stop(): void {
        this.generation += 1;
        const state = this.watchState;
        this.watchState = undefined;
        state?.socket.destroy();
    }

    private open(agentId: string, socketPath: string, redirects: number): void {
        const socket = createConnection(socketPath);
        socket.setEncoding("utf8");
        const state: Watch = {
            agentId,
            socket,
            generation: this.generation,
            redirects,
            connected: false,
            finished: false,
        };
        this.watchState = state;
        let buffered = "";
        let firstLine = true;
        socket.once("connect", () => {
            state.connected = true;
            socket.write(attachLine(agentId));
        });
        socket.on("data", (chunk: string) => {
            buffered += chunk;
            for (;;) {
                const newline = buffered.indexOf("\n");
                if (newline === -1) break;
                const line = buffered.slice(0, newline + 1);
                buffered = buffered.slice(newline + 1);
                if (firstLine) {
                    firstLine = false;
                    const target = redirectTarget(line);
                    if (target !== undefined) {
                        this.redirect(state, target);
                        return;
                    }
                }
                if (this.isCurrent(state)) this.emit({ type: "session_frame", agentId, text: line });
            }
            if (buffered.length > MAX_FRAME_BYTES) {
                this.finish(state, "The host sent a frame larger than this client accepts.");
            }
        });
        socket.once("error", (error: NodeJS.ErrnoException) => this.finish(state, describeFailure(error)));
        socket.once("close", () => this.finish(state, CLOSED_BY_HOST));
    }

    private redirect(state: Watch, socketPath: string): void {
        if (!this.isCurrent(state)) return;
        this.stop();
        if (state.redirects >= MAX_REDIRECTS) {
            this.emit({ type: "session_closed", agentId: state.agentId, reason: MOVED_TWICE });
            return;
        }
        this.open(state.agentId, socketPath, state.redirects + 1);
    }

    private finish(state: Watch, reason: string): void {
        if (state.finished) return;
        state.finished = true;
        state.socket.destroy();
        if (!this.isCurrent(state)) return;
        this.watchState = undefined;
        this.emit({ type: "session_closed", agentId: state.agentId, reason });
    }

    private isCurrent(state: Watch): boolean {
        return state.generation === this.generation;
    }
}

function attachLine(agentId: string): string {
    return `${JSON.stringify({
        type: "attach",
        agent_id: agentId,
        requested_capabilities: [HOST_CAPABILITY_AGENT_HISTORY_PAGING],
    })}\n`;
}

// The host answers a watch on the wrong socket with one location line before anything else.
function redirectTarget(line: string): string | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch {
        return undefined;
    }
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const value = parsed as { type?: unknown; socket_path?: unknown };
    if (value.type !== "agent_location_changed") return undefined;
    if (typeof value.socket_path !== "string" || !isAbsolute(value.socket_path)) return undefined;
    return value.socket_path;
}
