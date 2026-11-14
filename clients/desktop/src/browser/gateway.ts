import { requestExtensionThroughHost } from "../../../../src/host/extension-request-client.ts";
import { parseBrowserRequest } from "../../../../extensions/desktop-browser/arguments.ts";
import type { JsonValue } from "../../../../src/sdk/hooks.ts";
import { BrowserCdp } from "./cdp.ts";

const EXTENSION = "vera.desktop-browser";

export class BrowserGateway {
    private controller: AbortController | undefined;
    private socket: string | undefined;
    enabled = false;
    available = false;

    constructor(private readonly cdp: BrowserCdp, private readonly reveal: () => void) {}

    start(socket: string): void {
        this.stop();
        this.socket = socket;
        const controller = new AbortController();
        this.controller = controller;
        void this.loop(socket, controller.signal);
        void this.settings();
    }

    stop(): void {
        this.controller?.abort();
        this.controller = undefined;
        this.socket = undefined;
        this.enabled = false;
        this.available = false;
    }

    async settings(enabled?: boolean): Promise<void> {
        if (this.socket === undefined) return;
        try {
            const result = await requestExtensionThroughHost(this.socket, EXTENSION, "settings", enabled === undefined ? {} : { enabled }, AbortSignal.timeout(5000));
            if (isRecord(result) && typeof result.enabled === "boolean") {
                this.enabled = result.enabled;
                this.available = true;
            }
        } catch { this.available = false; }
    }

    async forget(): Promise<void> {
        if (this.socket === undefined) throw new Error("The host is not running.");
        await requestExtensionThroughHost(this.socket, EXTENSION, "forget", {}, AbortSignal.timeout(30_000));
    }

    private async loop(socket: string, signal: AbortSignal): Promise<void> {
        while (!signal.aborted) {
            try {
                const job = await requestExtensionThroughHost(socket, EXTENSION, "poll", {}, signal);
                if (signal.aborted) break;
                if (job === null) {
                    await this.settings();
                    continue;
                }
                if (!isRecord(job) || typeof job.id !== "string") continue;
                const raw = job.request;
                if (isRecord(raw) && raw.action === "forget") {
                    let result: Record<string, unknown>;
                    try { await this.cdp.forget(); result = { output: "Browsing data cleared." }; }
                    catch (error) { result = { error: error instanceof Error ? error.message : "Could not forget browsing data." }; }
                    await requestExtensionThroughHost(socket, EXTENSION, "reply", { id: job.id, ...result } as JsonValue, signal);
                    continue;
                }
                const request = isRecord(raw) ? parseBrowserRequest(raw) : undefined;
                let result: Record<string, unknown>;
                if (request === undefined) result = { error: "Invalid browser request." };
                else if (!this.enabled) result = { error: "Browser tools are off in the desktop window." };
                else {
                    this.reveal();
                    try { result = await this.cdp.run(request); }
                    catch (error) { result = { error: error instanceof Error ? error.message : "Browser request failed." }; }
                }
                if (signal.aborted) break;
                await requestExtensionThroughHost(socket, EXTENSION, "reply", { id: job.id, ...result } as JsonValue, signal);
            } catch {
                if (signal.aborted) break;
                this.available = false;
                await new Promise<void>((resolve) => setTimeout(resolve, 1000));
            }
        }
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
