import { chmodSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { VeraExtensionApi, VeraExtensionToolResult } from "../../src/sdk/extensions.ts";
import type { JsonValue } from "../../src/sdk/hooks.ts";
import { parseBrowserRequest, type BrowserRequest } from "./arguments.ts";

const DESCRIPTION = "Use the desktop Browser pane. Open an http or https URL, read page text and accessibility refs, click or type by ref, scroll, go back, or take a screenshot. Read the page before using refs.";
const MAX_IMAGE = 800_000;
const MAX_PENDING = 8;

interface Job {
    readonly id: string;
    readonly request: BrowserRequest | { readonly action: "forget" };
    readonly finish: (reply: Record<string, unknown>) => void;
}

export function activate(vera: VeraExtensionApi): void {
    const root = (): string => vera.storage.profile;
    const settingsPath = (): string => join(root(), "settings.json");
    const jobs = new Map<string, Job>();
    let waiting: ((job: Job | undefined) => void) | undefined;
    let desktopSeen = 0;

    const enabled = (): boolean => {
        try { return JSON.parse(readFileSync(settingsPath(), "utf8")).enabled === true; } catch { return false; }
    };
    const setEnabled = (value: boolean): void => {
        mkdirSync(root(), { recursive: true, mode: 0o700 });
        chmodSync(root(), 0o700);
        writeFileSync(settingsPath(), JSON.stringify({ enabled: value }), { mode: 0o600 });
        chmodSync(settingsPath(), 0o600);
    };

    vera.requests.handle("settings", (payload: JsonValue): JsonValue => {
        if (isRecord(payload) && typeof payload.enabled === "boolean") {
            setEnabled(payload.enabled);
            if (!payload.enabled) for (const job of jobs.values()) {
                if (job.request.action !== "forget") job.finish({ error: "Browser tools are off in the desktop window." });
            }
        }
        return { enabled: enabled() };
    });
    vera.requests.handle("poll", async (_payload, context): Promise<JsonValue> => {
        desktopSeen = Date.now();
        const queued = [...jobs.values()].find((job) => !delivered.has(job.id));
        if (queued !== undefined) {
            delivered.add(queued.id);
            return { id: queued.id, request: queued.request as unknown as JsonValue };
        }
        return await new Promise<JsonValue>((resolve) => {
            const finish = (job: Job | undefined): void => {
                clearTimeout(timer);
                context.signal.removeEventListener("abort", abort);
                if (waiting === finish) waiting = undefined;
                if (job !== undefined) delivered.add(job.id);
                resolve(job === undefined ? null : { id: job.id, request: job.request as unknown as JsonValue });
            };
            const abort = (): void => { desktopSeen = 0; finish(undefined); };
            const timer = setTimeout(() => finish(undefined), 10_000);
            waiting?.(undefined);
            waiting = finish;
            context.signal.addEventListener("abort", abort, { once: true });
        });
    });
    const delivered = new Set<string>();
    vera.requests.handle("reply", (payload: JsonValue): JsonValue => {
        if (!isRecord(payload) || typeof payload.id !== "string") return false;
        const job = jobs.get(payload.id);
        if (job === undefined) return false;
        job.finish(payload as Record<string, unknown>);
        return true;
    });

    const dispatch = async (request: Job["request"], signal: AbortSignal): Promise<Record<string, unknown>> => {
        signal.throwIfAborted();
        if (Date.now() - desktopSeen > 15_000) return { error: "Open the desktop window to use browser tools." };
        if (jobs.size >= MAX_PENDING) return { error: "The browser is busy." };
        const id = randomUUID();
        return await new Promise<Record<string, unknown>>((resolve) => {
            const finish = (reply: Record<string, unknown>): void => {
                clearTimeout(timer);
                signal.removeEventListener("abort", abort);
                jobs.delete(id);
                delivered.delete(id);
                resolve(reply);
            };
            const abort = (): void => finish({ error: "Browser request cancelled." });
            const timer = setTimeout(() => finish({ error: "The desktop window did not answer." }), 25_000);
            const job = { id, request, finish };
            jobs.set(id, job);
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) { abort(); return; }
            waiting?.(job);
        });
    };
    vera.requests.handle("forget", async (_payload, { signal }): Promise<JsonValue> => {
        const result = await dispatch({ action: "forget" }, signal);
        if (typeof result.error === "string") throw new Error(result.error);
        const directory = join(root(), "captures");
        try {
            for (const name of readdirSync(directory)) {
                if (/^capture-[0-9]+-[a-f0-9-]+\.jpg$/.test(name)) unlinkSync(join(directory, name));
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        return true;
    });

    vera.tools.register({
        name: "desktop_browser",
        description: DESCRIPTION,
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["open", "read", "click", "type", "scroll", "back", "screenshot"] },
                url: { type: "string" }, ref: { type: "string" }, text: { type: "string" }, amount: { type: "number" },
            },
            required: ["action"], additionalProperties: false,
        },
        permissionOperation: "desktop.browser",
        parallel: false,
        timeoutMs: 30_000,
        run: async ({ input, signal }): Promise<VeraExtensionToolResult> => {
            const request = parseBrowserRequest(input);
            if (request === undefined) return { output: "Invalid browser request.", isError: true };
            if (!enabled()) return { output: "Browser tools are off in the desktop window.", isError: true };
            const result = await dispatch(request, signal);
            if (typeof result.error === "string") return { output: result.error.slice(0, 1000), isError: true };
            if (request.action === "screenshot" && typeof result.image === "string") {
                if (result.image.length > MAX_IMAGE || !/^[A-Za-z0-9+/=]+$/.test(result.image)) return { output: "Screenshot is too large.", isError: true };
                const directory = join(root(), "captures");
                mkdirSync(directory, { recursive: true, mode: 0o700 });
                for (const name of readdirSync(directory).filter((entry) => /^capture-[0-9]+-[a-f0-9-]+\.jpg$/.test(entry)).sort().slice(0, -7)) unlinkSync(join(directory, name));
                const path = join(directory, `capture-${Date.now()}-${randomUUID()}.jpg`);
                writeFileSync(path, Buffer.from(result.image, "base64"), { mode: 0o600, flag: "wx" });
                return { output: "Screenshot captured.", imagePaths: [path] };
            }
            return { output: typeof result.output === "string" ? result.output.slice(0, 30_000) : "Browser returned no result." };
        },
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
