import { createConnection, type Socket } from "node:net";

import type { DesktopEvent } from "../../ui/src/protocol/bridge.ts";

const MAX_FRAME_BYTES = 1_048_576;
const EXCHANGE_TIMEOUT_MS = 10_000;

// The host answers one request per connection and closes it. Each frame the UI
// sends gets its own connection; the socket path is kept for reconnects.
// Replies are framed per connection and forwarded as whole lines, so two
// answers in flight never interleave inside one frame.
export class HostPipe {
    private socketPath: string | undefined;
    private generation = 0;
    private readonly sockets = new Set<Socket>();

    constructor(private readonly emit: (event: DesktopEvent) => void) {}

    connect(socketPath: string): void {
        this.close();
        this.socketPath = socketPath;
    }

    send(text: string): void {
        const socketPath = this.socketPath;
        if (socketPath === undefined) return;
        const generation = this.generation;
        const socket = createConnection(socketPath);
        socket.setEncoding("utf8");
        this.sockets.add(socket);
        let buffered = "";
        let received = false;
        let lost = false;
        let timedOut = false;
        socket.setTimeout(EXCHANGE_TIMEOUT_MS, () => {
            timedOut = true;
            socket.destroy();
        });
        const current = (): boolean => this.generation === generation;
        const lose = (reason: string): void => {
            if (lost) return;
            lost = true;
            socket.destroy();
            if (current()) this.emit({ type: "disconnected", reason });
        };
        socket.once("connect", () => socket.write(text));
        socket.on("data", (chunk: string) => {
            received = true;
            buffered += chunk;
            for (;;) {
                const newline = buffered.indexOf("\n");
                if (newline === -1) break;
                const line = buffered.slice(0, newline + 1);
                buffered = buffered.slice(newline + 1);
                if (current()) this.emit({ type: "frame", text: line });
            }
            if (buffered.length > MAX_FRAME_BYTES) {
                lose("The host sent a frame larger than this client accepts.");
            }
        });
        socket.once("error", (error: NodeJS.ErrnoException) => lose(describeFailure(error)));
        socket.once("close", () => {
            this.sockets.delete(socket);
            if (!received && !lost && !timedOut) {
                lose("The host closed the connection before it answered.");
            }
        });
    }

    close(): void {
        this.generation += 1;
        this.socketPath = undefined;
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
    }
}

function describeFailure(error: NodeJS.ErrnoException): string {
    return error.code === "ENOENT" || error.code === "ECONNREFUSED"
        ? "The host is not running."
        : error.message;
}
