import { isSessionPane, type SessionPane } from "../../ui/src/protocol/panes.ts";
import type { DesktopEvent } from "../../ui/src/protocol/bridge.ts";
import { SessionPipe } from "./session-pipe.ts";

// The watch connection of every pane. Chat panes are made when first named, up to the limit isSessionPane allows.
export class SessionPanes {
    private readonly pipes = new Map<SessionPane, SessionPipe>();
    private socketPath: string | undefined;

    constructor(
        private readonly emit: (event: DesktopEvent) => void,
        private readonly hidesReasoning: () => boolean,
    ) {
        for (const pane of ["main", "companion", "subagent"] as const) this.pipes.set(pane, new SessionPipe(emit, pane, hidesReasoning));
    }

    // The pipe for a pane the window named, or undefined when the name is not one.
    get(value: unknown): SessionPipe | undefined {
        if (!isSessionPane(value)) return undefined;
        let pipe = this.pipes.get(value);
        if (pipe === undefined) {
            pipe = new SessionPipe(this.emit, value, this.hidesReasoning);
            if (this.socketPath !== undefined) pipe.connect(this.socketPath);
            this.pipes.set(value, pipe);
        }
        return pipe;
    }

    connect(socketPath: string): void {
        this.socketPath = socketPath;
        for (const pipe of this.pipes.values()) pipe.connect(socketPath);
    }

    close(): void {
        this.socketPath = undefined;
        for (const pipe of this.pipes.values()) pipe.close();
    }

    reattach(): void {
        for (const pipe of this.pipes.values()) pipe.reattach();
    }
}
