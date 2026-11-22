// One worker per active extension. Nothing starts until a command of the extension runs, and stopping an
// extension ends its worker whatever it is doing, so cleanup never depends on the extension's own code.

import type { ExtensionLogLevel, ExtensionMainResult } from "../protocol/desktop-extensions.ts";
import { ownsContextKey } from "./context.ts";
import { isPlainData, parseFromWorker, type ContextValue, type PlainData, type ToastTone, type ToWorker } from "./envelope.ts";

// "not-responding" means the last worker was stopped because it did not answer; no worker is running.
export type ExtensionState = "inactive" | "activating" | "active" | "not-responding" | "failed";

export interface ExtensionStatus {
    readonly extensionId: string;
    readonly state: ExtensionState;
    // Set when the state is failed.
    readonly reason?: string;
}

export interface ExtensionDefinition {
    readonly id: string;
    readonly main?: string;
    readonly commands: readonly string[];
}

export interface WorkerLink {
    post(message: ToWorker): void;
    // Removes the frame, which ends the worker.
    terminate(): void;
}

export interface Timers {
    readonly set: (run: () => void, ms: number) => unknown;
    readonly clear: (handle: unknown) => void;
    readonly now: () => number;
}

export interface RuntimeHost {
    readSource(extensionId: string, main: string): Promise<ExtensionMainResult>;
    // `receive` takes whatever the worker sent; the runtime parses it.
    createLink(extensionId: string, receive: (data: unknown) => void): WorkerLink;
    toast(text: string, tone: ToastTone): void;
    log(extensionId: string, level: ExtensionLogLevel, text: string): void;
    setContext(key: string, value: ContextValue | undefined): void;
    readonly timers: Timers;
}

export const PING_AFTER_MS = 3_000;
export const PONG_WITHIN_MS = 3_000;
export const MAX_MESSAGES_PER_SECOND = 200;
export const MAX_CONTEXT_KEYS = 64;
export const MAX_QUEUED_RUNS = 20;

interface Call {
    readonly command: string;
    readonly args: PlainData | undefined;
    posted: boolean;
}

// One run of a worker. A stopped session stays closed, so a late message from its worker is ignored.
interface Session {
    readonly extensionId: string;
    link: WorkerLink | undefined;
    closed: boolean;
    loaded: boolean;
    state: ExtensionState;
    reason: string | undefined;
    readonly calls: Map<number, Call>;
    readonly keys: Set<string>;
    nextCall: number;
    nextPing: number;
    watch: unknown;
    pong: unknown;
    windowStart: number;
    windowCount: number;
    windowDropped: boolean;
}

export class ExtensionRuntime {
    private readonly host: RuntimeHost;
    private readonly definitions = new Map<string, ExtensionDefinition>();
    private readonly sessions = new Map<string, Session>();
    private readonly settled = new Map<string, ExtensionStatus>();
    private readonly listeners = new Set<() => void>();
    private cached: readonly ExtensionStatus[] | undefined;

    constructor(host: RuntimeHost) {
        this.host = host;
    }

    // Replaces the known extensions. One that is gone, or whose main or commands changed, is stopped.
    define(definitions: readonly ExtensionDefinition[]): void {
        const next = new Map(definitions.map((definition) => [definition.id, definition]));
        for (const [id, previous] of this.definitions) {
            const current = next.get(id);
            const same = current !== undefined && current.main === previous.main
                && current.commands.length === previous.commands.length
                && current.commands.every((command, index) => command === previous.commands[index]);
            if (!same) this.stop(id);
            if (current === undefined) this.settled.delete(id);
        }
        this.definitions.clear();
        for (const [id, definition] of next) this.definitions.set(id, definition);
        this.changed();
    }

    // Runs one command of an extension, starting its worker first when there is none.
    run(extensionId: string, commandId: string, args?: unknown): void {
        const definition = this.definitions.get(extensionId);
        if (definition === undefined || !definition.commands.includes(commandId)) {
            this.host.log(extensionId, "error", `Command "${commandId}" is not declared by this extension.`);
            return;
        }
        if (args !== undefined && !isPlainData(args)) {
            this.host.log(extensionId, "error", `Command "${commandId}" was given arguments that are not plain data.`);
            return;
        }
        let session = this.sessions.get(extensionId);
        if (session === undefined) session = this.start(definition);
        if (session === undefined) return;
        if (session.calls.size >= MAX_QUEUED_RUNS) {
            this.host.log(extensionId, "error", `Command "${commandId}" was dropped: ${MAX_QUEUED_RUNS} runs are already waiting.`);
            return;
        }
        const call = session.nextCall;
        session.nextCall += 1;
        session.calls.set(call, { command: commandId, args: args as PlainData | undefined, posted: false });
        if (session.state === "active") this.post(session, call);
        this.arm(session);
    }

    // Ends the extension's worker and clears its context keys. The next run starts a fresh worker.
    stop(extensionId: string): void {
        const session = this.sessions.get(extensionId);
        const hadSettled = this.settled.delete(extensionId);
        if (session === undefined) {
            if (hadSettled) this.changed();
            return;
        }
        this.close(session);
        this.sessions.delete(extensionId);
        this.changed();
    }

    stopAll(): void {
        for (const id of [...this.sessions.keys()]) this.stop(id);
    }

    snapshot(): readonly ExtensionStatus[] {
        this.cached ??= [...this.definitions.keys()].map((extensionId): ExtensionStatus => {
            const session = this.sessions.get(extensionId);
            if (session !== undefined) {
                return { extensionId, state: session.state, ...(session.reason === undefined ? {} : { reason: session.reason }) };
            }
            return this.settled.get(extensionId) ?? { extensionId, state: "inactive" };
        });
        return this.cached;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private start(definition: ExtensionDefinition): Session | undefined {
        const extensionId = definition.id;
        if (definition.main === undefined) {
            this.host.log(extensionId, "error", "The extension has no main file.");
            return undefined;
        }
        const session: Session = {
            extensionId,
            link: undefined,
            closed: false,
            loaded: false,
            state: "activating",
            reason: undefined,
            calls: new Map(),
            keys: new Set(),
            nextCall: 1,
            nextPing: 1,
            watch: undefined,
            pong: undefined,
            windowStart: this.host.timers.now(),
            windowCount: 0,
            windowDropped: false,
        };
        this.sessions.set(extensionId, session);
        this.settled.delete(extensionId);
        this.changed();
        void this.load(session, definition.main, definition.commands);
        return session;
    }

    private async load(session: Session, main: string, commands: readonly string[]): Promise<void> {
        let result: ExtensionMainResult;
        try {
            result = await this.host.readSource(session.extensionId, main);
        } catch {
            result = { ok: false, reason: "The extension file could not be read." };
        }
        if (session.closed) return;
        if (!result.ok) {
            this.fail(session, result.reason);
            return;
        }
        try {
            session.link = this.host.createLink(session.extensionId, (data) => this.receive(session, data));
            session.link.post({ type: "load", source: result.source, commands });
        } catch {
            this.fail(session, "The extension frame could not start.");
        }
    }

    private post(session: Session, call: number): void {
        const entry = session.calls.get(call);
        if (entry === undefined || entry.posted || session.link === undefined) return;
        entry.posted = true;
        session.link.post({
            type: "run",
            call,
            command: entry.command,
            ...(entry.args === undefined ? {} : { args: entry.args }),
        });
    }

    // A call in flight for more than PING_AFTER_MS makes the window ping. No answer in time stops the worker, which
    // would otherwise keep a core busy; the next run starts a fresh one.
    private arm(session: Session): void {
        if (session.closed || session.watch !== undefined || session.pong !== undefined || session.calls.size === 0) return;
        session.watch = this.host.timers.set(() => {
            session.watch = undefined;
            if (session.closed || session.calls.size === 0 || session.link === undefined) return;
            const n = session.nextPing;
            session.nextPing += 1;
            session.link.post({ type: "ping", n });
            session.pong = this.host.timers.set(() => {
                session.pong = undefined;
                if (session.closed) return;
                const id = session.extensionId;
                this.host.log(id, "warn", "The extension did not answer a ping in time.");
                this.host.toast(`Extension ${id} stopped responding and was stopped.`, "warning");
                this.close(session);
                this.sessions.delete(id);
                this.settled.set(id, { extensionId: id, state: "not-responding" });
                this.changed();
            }, PONG_WITHIN_MS);
        }, PING_AFTER_MS);
    }

    private disarm(session: Session): void {
        if (session.watch !== undefined) this.host.timers.clear(session.watch);
        if (session.pong !== undefined) this.host.timers.clear(session.pong);
        session.watch = undefined;
        session.pong = undefined;
    }

    private receive(session: Session, data: unknown): void {
        if (session.closed) return;
        if (!this.admit(session)) return;
        const message = parseFromWorker(data);
        if (message === undefined) {
            this.host.log(session.extensionId, "error", "Refused a malformed message from the extension.");
            return;
        }
        const id = session.extensionId;
        switch (message.type) {
            case "loaded":
                if (session.loaded) return;
                session.loaded = true;
                this.settle(session, "active");
                for (const call of session.calls.keys()) this.post(session, call);
                return;
            case "load-failed":
                if (session.loaded) return;
                this.fail(session, message.reason);
                return;
            case "done":
                this.finish(session, message.call);
                return;
            case "failed": {
                const command = session.calls.get(message.call)?.command;
                this.finish(session, message.call);
                if (command === undefined) return;
                this.host.log(id, "error", `${command} failed: ${message.reason}`);
                this.host.toast(`Command ${command} failed: ${message.reason}`, "danger");
                return;
            }
            case "pong":
                if (session.pong === undefined) return;
                this.host.timers.clear(session.pong);
                session.pong = undefined;
                this.arm(session);
                return;
            case "toast":
                this.host.toast(`${id}: ${message.text}`, message.tone ?? "info");
                return;
            case "log":
                this.host.log(id, message.level, message.text);
                return;
            case "context":
                this.setContext(session, message.key, message.value);
                return;
        }
    }

    private setContext(session: Session, key: string, value: ContextValue | undefined): void {
        const id = session.extensionId;
        if (!ownsContextKey(id, key)) {
            this.host.log(id, "error", `Refused context key "${key}": it must start with "${id}.".`);
            return;
        }
        if (value === undefined) {
            session.keys.delete(key);
        } else if (!session.keys.has(key)) {
            if (session.keys.size >= MAX_CONTEXT_KEYS) {
                this.host.log(id, "error", `Refused context key "${key}": an extension may set ${MAX_CONTEXT_KEYS} keys.`);
                return;
            }
            session.keys.add(key);
        }
        this.host.setContext(key, value);
    }

    private finish(session: Session, call: number): void {
        if (!session.calls.delete(call)) return;
        if (session.calls.size === 0) this.disarm(session);
    }

    // A fixed one-second window: a worker that floods the channel loses the excess without slowing the window.
    private admit(session: Session): boolean {
        const now = this.host.timers.now();
        if (now - session.windowStart >= 1_000) {
            session.windowStart = now;
            session.windowCount = 0;
            session.windowDropped = false;
        }
        session.windowCount += 1;
        if (session.windowCount <= MAX_MESSAGES_PER_SECOND) return true;
        if (!session.windowDropped) {
            session.windowDropped = true;
            this.host.log(session.extensionId, "warn", `Dropped messages over ${MAX_MESSAGES_PER_SECOND} a second.`);
        }
        return false;
    }

    private fail(session: Session, reason: string): void {
        const id = session.extensionId;
        this.host.log(id, "error", `Could not start: ${reason}`);
        this.host.toast(`Extension ${id} could not start: ${reason}`, "danger");
        this.close(session);
        session.state = "failed";
        session.reason = reason;
        this.settled.set(id, { extensionId: id, state: "failed", reason });
        this.sessions.delete(id);
        this.changed();
    }

    private settle(session: Session, state: ExtensionState): void {
        if (session.state === state) return;
        session.state = state;
        this.changed();
    }

    private close(session: Session): void {
        session.closed = true;
        this.disarm(session);
        try {
            session.link?.terminate();
        } catch {
            // The frame is already gone.
        }
        session.link = undefined;
        session.calls.clear();
        for (const key of session.keys) this.host.setContext(key, undefined);
        session.keys.clear();
    }

    private changed(): void {
        this.cached = undefined;
        for (const listener of [...this.listeners]) listener();
    }
}
