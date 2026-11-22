import { requestExtensionThroughHost } from "../../../../src/host/extension-request-client.ts";
import { parseBrowserRequest } from "../../../../extensions/builtin-browser/arguments.ts";
import { BROWSER_TOOLS_OFF, BROWSER_TOOLS_OFF_TEXT } from "../../../../extensions/builtin-browser/failure.ts";
import { HANDOFF_BUSY } from "../../../../extensions/builtin-browser/handoff.ts";
import type { JsonValue } from "../../../../src/sdk/hooks.ts";
import { NO_WEB_PAGE_ERROR, type BrowserCdp } from "./cdp.ts";
import type { BrowserHandoff } from "./handoff.ts";

const EXTENSION = "vera.builtin-browser";

export class BrowserGateway {
    private controller: AbortController | undefined;
    private socket: string | undefined;
    private refreshTimer: ReturnType<typeof setInterval> | undefined;
    private refreshing = false;
    private writes = 0;
    private revision = 0;
    enabled = false;
    offBehavior: "ask" | "refuse" = "ask";
    available = false;
    private toolsAsk: { id: string; answer: (approved: boolean) => void; answering: boolean } | undefined;

    constructor(
        private readonly cdp: BrowserCdp,
        private readonly reveal: () => void,
        private readonly changed: () => void,
        private readonly request: typeof requestExtensionThroughHost = requestExtensionThroughHost,
        private readonly handoff?: BrowserHandoff,
    ) {}

    start(socket: string): void {
        this.stop();
        this.socket = socket;
        const controller = new AbortController();
        this.controller = controller;
        void this.loop(socket, controller.signal);
        void this.settings();
        this.refreshTimer = setInterval(() => void this.settings(), 1000);
    }

    stop(): void {
        this.controller?.abort();
        this.handoff?.cancel();
        this.cancelToolsAsk();
        this.controller = undefined;
        if (this.refreshTimer !== undefined) clearInterval(this.refreshTimer);
        this.refreshTimer = undefined;
        this.socket = undefined;
        this.refreshing = false;
        this.writes = 0;
        this.revision++;
        this.update(this.enabled, false);
    }

    async settings(patch?: { enabled?: boolean; offBehavior?: "ask" | "refuse" }): Promise<boolean> {
        const socket = this.socket;
        const controller = this.controller;
        if (socket === undefined || controller === undefined) return false;
        if (patch === undefined) {
            if (this.refreshing || this.writes > 0) return false;
            this.refreshing = true;
        } else {
            this.writes++;
            this.revision++;
        }
        const revision = this.revision;
        try {
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]);
            const result = await this.request(socket, EXTENSION, "settings", patch ?? {}, signal);
            if (this.controller !== controller || this.revision !== revision) return false;
            if (!isRecord(result) || typeof result.enabled !== "boolean") return false;
            this.update(result.enabled, true);
            const offBehavior = result.offBehavior === "refuse" ? "refuse" : "ask";
            if (offBehavior !== this.offBehavior) {
                this.offBehavior = offBehavior;
                this.changed();
            }
            return true;
        } catch {
            if (this.controller === controller && this.revision === revision) this.update(this.enabled, false);
            return false;
        } finally {
            if (this.controller === controller) {
                if (patch === undefined) this.refreshing = false;
                else this.writes--;
            }
        }
    }

    async answerToolsAsk(id: string, approved: boolean): Promise<void> {
        const pending = this.toolsAsk;
        if (pending === undefined || pending.id !== id || pending.answering) return;
        pending.answering = true;
        const saved = approved ? await this.settings({ enabled: true }) : true;
        if (this.toolsAsk !== pending) return;
        if (approved && (!saved || !this.enabled)) {
            pending.answering = false;
            return;
        }
        this.toolsAsk = undefined;
        pending.answer(approved);
        this.changed();
    }

    private askTools(id: string): Promise<boolean> {
        return new Promise((resolve) => {
            this.toolsAsk = { id, answer: resolve, answering: false };
            this.changed();
        });
    }

    private cancelToolsAsk(id?: string): void {
        const pending = this.toolsAsk;
        if (pending === undefined || (id !== undefined && pending.id !== id)) return;
        this.toolsAsk = undefined;
        pending.answer(false);
        this.changed();
    }

    get pendingToolsAsk(): { id: string } | undefined {
        return this.toolsAsk === undefined ? undefined : { id: this.toolsAsk.id };
    }

    private update(enabled: boolean, available: boolean): void {
        if (!enabled) this.handoff?.cancel();
        if (enabled === this.enabled && available === this.available) return;
        this.enabled = enabled;
        this.available = available;
        this.changed();
    }

    private async loop(socket: string, signal: AbortSignal): Promise<void> {
        while (!signal.aborted) {
            try {
                const job = await this.request(socket, EXTENSION, "poll", {}, signal);
                if (signal.aborted) break;
                if (job === null) {
                    await this.settings();
                    continue;
                }
                if (!isRecord(job)) continue;
                if (typeof job.cancel === "string") {
                    this.handoff?.cancel(job.cancel);
                    this.cancelToolsAsk(job.cancel);
                    continue;
                }
                if (typeof job.id !== "string") continue;
                const raw = job.request;
                if (isRecord(raw) && raw.action === "enable_tools") {
                    const pending = this.askTools(job.id);
                    void this.replyToolsAsk(socket, job.id, pending, signal);
                    continue;
                }
                const request = isRecord(raw) ? parseBrowserRequest(raw) : undefined;
                let result: Record<string, unknown>;
                if (request === undefined) result = { error: "Invalid browser request." };
                else if (this.handoff?.state() !== undefined) result = { error: HANDOFF_BUSY };
                else if (!this.enabled) result = { error: BROWSER_TOOLS_OFF_TEXT, errorCode: BROWSER_TOOLS_OFF };
                else {
                    this.reveal();
                    try {
                        if (request.action === "handoff") {
                            if (this.handoff === undefined) throw new Error(NO_WEB_PAGE_ERROR);
                            const pending = this.handoff.start(job.id, request.reason!);
                            void this.replyHandoff(socket, job.id, pending, signal);
                            continue;
                        }
                        result = await this.cdp.run(request);
                    } catch (error) { result = { error: error instanceof Error ? error.message : "Browser request failed." }; }
                }
                if (signal.aborted) break;
                await this.request(socket, EXTENSION, "reply", { id: job.id, ...result } as JsonValue, signal);
            } catch {
                if (signal.aborted) break;
                this.update(this.enabled, false);
                await new Promise<void>((resolve) => setTimeout(resolve, 1000));
            }
        }
    }

    private async replyToolsAsk(socket: string, id: string, pending: Promise<boolean>, signal: AbortSignal): Promise<void> {
        try {
            const approved = await pending;
            if (!signal.aborted) await this.request(socket, EXTENSION, "reply", { id, approved } as JsonValue, signal);
        } catch {
            if (!signal.aborted) this.update(this.enabled, false);
        }
    }

    private async replyHandoff(socket: string, id: string, pending: Promise<Record<string, unknown>>, signal: AbortSignal): Promise<void> {
        try {
            const result = await pending;
            if (!signal.aborted) await this.request(socket, EXTENSION, "reply", { id, ...result } as JsonValue, signal);
        } catch {
            if (!signal.aborted) this.update(this.enabled, false);
        }
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
