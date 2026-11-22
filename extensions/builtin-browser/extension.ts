import { chmodSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { VeraExtensionApi, VeraExtensionToolResult } from "../../src/sdk/extensions.ts";
import type { JsonValue } from "../../src/sdk/hooks.ts";
import { parseBrowserRequest, type BrowserRequest } from "./arguments.ts";
import { EVAL_DESCRIPTION, EVAL_RESULT_LIMIT, EVAL_SCRIPT_LIMIT, EVAL_TIMEOUT_LIMIT_MS, evalCut } from "./eval.ts";
import { BROWSER_TOOLS_OFF, BROWSER_TOOLS_OFF_TEXT } from "./failure.ts";
import { HANDOFF_BUSY, HANDOFF_CANCELLED, HANDOFF_TIMED_OUT } from "./handoff.ts";

const DESCRIPTION = "Use the built-in browser, the Browser pane in the Vera desktop window. Open an http or https URL, read the page as markdown with link URLs and tables plus accessibility refs, click or type by ref, scroll, go back, or take a screenshot. Read the page before using refs. A long page is cut: read again with the offset the reply gives to continue. If the page shows a CAPTCHA or another human check, use handoff with a short reason so the user can complete it in the pane, then read the page again. Never try to solve a human check yourself. It cannot control Vera's own pages such as Usage. If a tool named browser is also available, ask the user once which browser to use before the first call, and keep the answer for this conversation.";
const MAX_IMAGE = 800_000;
const MAX_PENDING = 8;
const MAX_OUTPUT = 30_000;
const MAX_CONTROLS = 10_000;
const MAX_MARKDOWN = 10_000_000;
const MAX_URL = 8192;
const MAX_TITLE = 300;
const HANDOFF_DEADLINE_MS = 10 * 60_000;
const ENABLE_TOOLS_DEADLINE_MS = 10 * 60_000;
const KEPT_OFF_TEXT = "The user kept Browser tools off.";
const ASK_EXPIRED_TEXT = "The user did not answer within 10 minutes, so Browser tools are still off.";
const CANCELLED_TEXT = "Browser request cancelled.";

interface BrowserSettings {
    readonly enabled: boolean;
    readonly offBehavior: "ask" | "refuse";
}

interface Job {
    readonly id: string;
    readonly request: BrowserRequest | { readonly action: "enable_tools" };
    readonly finish: (reply: Record<string, unknown>, cancel?: boolean) => void;
}

export function activate(vera: VeraExtensionApi): void {
    const root = (): string => vera.storage.profile;
    const settingsPath = (): string => join(root(), "settings.json");
    let settings = readSettings(settingsPath());
    const jobs = new Map<string, Job>();
    const delivered = new Set<string>();
    const cancelled = new Set<string>();
    let waiting: (() => void) | undefined;
    let desktopSeen = 0;
    let enableAsk: {
        readonly controller: AbortController;
        readonly waiters: Set<(result: Record<string, unknown>) => void>;
    } | undefined;

    const setSettings = (value: BrowserSettings): void => {
        mkdirSync(root(), { recursive: true, mode: 0o700 });
        chmodSync(root(), 0o700);
        writeFileSync(settingsPath(), JSON.stringify(value), { mode: 0o600 });
        chmodSync(settingsPath(), 0o600);
        settings = value;
    };

    vera.requests.handle("settings", (payload: JsonValue): JsonValue => {
        if (isRecord(payload) && (typeof payload.enabled === "boolean" || Object.hasOwn(payload, "offBehavior"))) {
            setSettings({
                enabled: typeof payload.enabled === "boolean" ? payload.enabled : settings.enabled,
                offBehavior: Object.hasOwn(payload, "offBehavior")
                    ? payload.offBehavior === "refuse" ? "refuse" : "ask"
                    : settings.offBehavior,
            });
            if (payload.enabled === false) for (const job of jobs.values()) {
                job.finish(job.request.action === "handoff"
                    ? { output: HANDOFF_CANCELLED }
                    : { error: BROWSER_TOOLS_OFF_TEXT, errorCode: BROWSER_TOOLS_OFF }, true);
            }
        }
        return { ...settings };
    });
    const next = (): JsonValue => {
        const cancel = cancelled.values().next().value;
        if (cancel !== undefined) {
            cancelled.delete(cancel);
            return { cancel };
        }
        const queued = [...jobs.values()].find((job) => !delivered.has(job.id));
        if (queued === undefined) return null;
        delivered.add(queued.id);
        return { id: queued.id, request: queued.request as unknown as JsonValue };
    };
    vera.requests.handle("poll", async (_payload, context): Promise<JsonValue> => {
        if (context.signal.aborted) return null;
        desktopSeen = Date.now();
        const ready = next();
        if (ready !== null) return ready;
        return await new Promise<JsonValue>((resolve) => {
            const finish = (read = true): void => {
                clearTimeout(timer);
                context.signal.removeEventListener("abort", abort);
                if (waiting === finish) waiting = undefined;
                resolve(read ? next() : null);
            };
            const abort = (): void => { desktopSeen = 0; finish(false); };
            const timer = setTimeout(finish, 10_000);
            waiting?.();
            waiting = finish;
            context.signal.addEventListener("abort", abort, { once: true });
            if (context.signal.aborted) abort();
        });
    });
    vera.requests.handle("reply", (payload: JsonValue): JsonValue => {
        if (!isRecord(payload) || typeof payload.id !== "string") return false;
        const job = jobs.get(payload.id);
        if (job === undefined || (job.request.action === "enable_tools" && typeof payload.approved !== "boolean")) return false;
        job.finish(payload as Record<string, unknown>);
        return true;
    });

    const dispatch = async (request: Job["request"], signal: AbortSignal): Promise<Record<string, unknown>> => {
        signal.throwIfAborted();
        for (const job of jobs.values()) {
            if (job.request.action === "handoff" && delivered.has(job.id)) return { error: HANDOFF_BUSY };
        }
        if (Date.now() - desktopSeen > 15_000) return { error: "Open the desktop window to use browser tools." };
        if (jobs.size + cancelled.size >= MAX_PENDING) return { error: "The browser is busy." };
        const id = randomUUID();
        return await new Promise<Record<string, unknown>>((resolve) => {
            const finish = (reply: Record<string, unknown>, cancel = false): void => {
                if (!jobs.has(id)) return;
                clearTimeout(timer);
                signal.removeEventListener("abort", abort);
                if (cancel && delivered.has(id)) cancelled.add(id);
                jobs.delete(id);
                delivered.delete(id);
                resolve(reply);
                if (cancel) waiting?.();
            };
            const abort = (): void => finish(request.action === "handoff" ? { output: HANDOFF_CANCELLED } : { error: CANCELLED_TEXT }, true);
            const timer = setTimeout(() => finish(
                request.action === "handoff" ? { output: HANDOFF_TIMED_OUT }
                    : request.action === "enable_tools" ? { error: ASK_EXPIRED_TEXT, errorCode: BROWSER_TOOLS_OFF }
                    : { error: "The desktop window did not answer." },
                true,
            ), request.action === "handoff" ? HANDOFF_DEADLINE_MS : request.action === "enable_tools" ? ENABLE_TOOLS_DEADLINE_MS : 25_000);
            const job = { id, request, finish };
            jobs.set(id, job);
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) { abort(); return; }
            waiting?.();
        });
    };

    const askToEnable = async (signal: AbortSignal): Promise<Record<string, unknown>> => {
        if (signal.aborted) return { error: CANCELLED_TEXT };
        if (enableAsk === undefined) {
            const controller = new AbortController();
            const current = { controller, waiters: new Set<(result: Record<string, unknown>) => void>() };
            enableAsk = current;
            void dispatch({ action: "enable_tools" }, controller.signal).then((result) => {
                if (enableAsk === current) enableAsk = undefined;
                for (const finish of current.waiters) finish(result);
            });
        }
        const current = enableAsk;
        return await new Promise<Record<string, unknown>>((resolve) => {
            const finish = (result: Record<string, unknown>): void => {
                signal.removeEventListener("abort", abort);
                current.waiters.delete(finish);
                resolve(result);
            };
            const abort = (): void => {
                finish({ error: CANCELLED_TEXT });
                if (current.waiters.size === 0 && enableAsk === current) {
                    enableAsk = undefined;
                    current.controller.abort();
                }
            };
            current.waiters.add(finish);
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
        });
    };

    const ensureEnabled = async (signal: AbortSignal): Promise<VeraExtensionToolResult | undefined> => {
        if (enableAsk === undefined && settings.enabled) return undefined;
        if (enableAsk === undefined && settings.offBehavior === "refuse") return browserToolsOff();
        const result = await askToEnable(signal);
        if (result.errorCode === BROWSER_TOOLS_OFF) {
            return browserToolsOff(typeof result.error === "string" ? result.error : BROWSER_TOOLS_OFF_TEXT);
        }
        if (typeof result.error === "string") return { output: result.error.slice(0, 1000), isError: true };
        if (result.approved !== true || !settings.enabled) return browserToolsOff(KEPT_OFF_TEXT);
        return undefined;
    };

    vera.tools.register({
        name: "builtin_browser",
        description: DESCRIPTION,
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["open", "read", "click", "type", "scroll", "back", "screenshot", "handoff"] },
                url: { type: "string" }, ref: { type: "string" }, text: { type: "string" }, amount: { type: "number" }, reason: { type: "string", maxLength: 300 },
                offset: { type: "integer", minimum: 0, maximum: 10_000_000 },
            },
            required: ["action"], additionalProperties: false,
        },
        permissionOperation: "desktop.browser",
        parallel: false,
        timeoutMs: ENABLE_TOOLS_DEADLINE_MS + HANDOFF_DEADLINE_MS + 30_000,
        run: async ({ input, signal }): Promise<VeraExtensionToolResult> => {
            const request = parseBrowserRequest(input);
            if (request === undefined || request.action === "eval") return { output: "Invalid browser request.", isError: true };
            if (enableAsk !== undefined || !settings.enabled) {
                const denied = await ensureEnabled(signal);
                if (denied !== undefined) return denied;
            }
            const result = await dispatch(request, signal);
            if (result.errorCode === BROWSER_TOOLS_OFF) return browserToolsOff();
            if (typeof result.error === "string") return { output: result.error.slice(0, 1000), isError: true };
            if (request.action === "read") {
                const output = await formatRead(result, request.offset ?? 0);
                return { output: output ?? "Browser returned no result.", ...(output === undefined ? { isError: true } : {}) };
            }
            if (request.action === "screenshot" && typeof result.image === "string") {
                if (result.image.length > MAX_IMAGE || !/^[A-Za-z0-9+/=]+$/.test(result.image)) return { output: "Screenshot is too large.", isError: true };
                const directory = join(root(), "captures");
                mkdirSync(directory, { recursive: true, mode: 0o700 });
                for (const name of readdirSync(directory).filter((entry) => /^capture-[0-9]+-[a-f0-9-]+\.jpg$/.test(entry)).sort().slice(0, -7)) unlinkSync(join(directory, name));
                const path = join(directory, `capture-${Date.now()}-${randomUUID()}.jpg`);
                writeFileSync(path, Buffer.from(result.image, "base64"), { mode: 0o600, flag: "wx" });
                return { output: "Screenshot captured.", imagePaths: [path] };
            }
            return { output: typeof result.output === "string" ? result.output.slice(0, MAX_OUTPUT) : "Browser returned no result." };
        },
    });

    vera.tools.register({
        name: "builtin_browser_eval",
        description: EVAL_DESCRIPTION,
        inputSchema: {
            type: "object",
            properties: {
                script: { type: "string", maxLength: EVAL_SCRIPT_LIMIT },
                timeout_ms: { type: "integer", minimum: 1, maximum: EVAL_TIMEOUT_LIMIT_MS },
            },
            required: ["script"], additionalProperties: false,
        },
        permissionOperation: "desktop.browser.eval",
        parallel: false,
        timeoutMs: ENABLE_TOOLS_DEADLINE_MS + 30_000,
        run: async ({ input, signal }): Promise<VeraExtensionToolResult> => {
            const request = parseBrowserRequest({ ...input, action: "eval" });
            if (request === undefined) return { output: "Invalid browser request.", isError: true };
            if (enableAsk !== undefined || !settings.enabled) {
                const denied = await ensureEnabled(signal);
                if (denied !== undefined) return denied;
            }
            const result = await dispatch(request, signal);
            if (result.errorCode === BROWSER_TOOLS_OFF) return browserToolsOff();
            if (typeof result.error === "string") return { output: result.error.slice(0, 1000), isError: true };
            if (typeof result.output !== "string") return { output: "Browser returned no result.", isError: true };
            const json = result.output.slice(0, EVAL_RESULT_LIMIT);
            const total = typeof result.total === "number" && Number.isFinite(result.total) ? Math.max(result.total, json.length) : json.length;
            return { output: total > json.length ? `${json}\n\n${evalCut(total)}` : json };
        },
    });
}

async function formatRead(result: Record<string, unknown>, offset: number): Promise<string | undefined> {
    if (typeof result.url !== "string" || typeof result.title !== "string" || typeof result.html !== "string"
        || !Array.isArray(result.controls) || !result.controls.every((row: unknown) => typeof row === "string")
        || typeof result.htmlTruncated !== "boolean" || typeof result.humanCheck !== "boolean") return undefined;

    const { htmlToMarkdown } = await import("../../src/tools/html-to-markdown.ts");
    const { markdown, truncated: markdownTruncated } = htmlToMarkdown(result.html, result.url, { maxLength: MAX_MARKDOWN });
    const rows: string[] = [];
    let controlsLength = 0;
    for (const row of result.controls) {
        const length = row.length + (rows.length === 0 ? 0 : 1);
        if (controlsLength + length > MAX_CONTROLS) break;
        rows.push(row);
        controlsLength += length;
    }
    if (rows.length < result.controls.length) rows.push(`Showing ${rows.length} of ${result.controls.length} controls.`);
    const hints: string[] = [];
    if (result.humanCheck) hints.push("This page shows a human check. Use handoff to ask the user to complete it.");
    if (result.htmlTruncated) hints.push("The page HTML is over 2 MiB, so only its first 2 MiB was read.");
    if (markdownTruncated) hints.push("The page is too long to read past 10,000,000 characters.");
    const start = Math.min(offset, markdown.length);
    const url = result.url.length > MAX_URL ? `${result.url.slice(0, MAX_URL)}…` : result.url;
    const title = result.title.length > MAX_TITLE ? `${result.title.slice(0, MAX_TITLE)}…` : result.title;
    const header = `URL: ${url}\nTitle: ${title}\n\n`;
    const hint = hints.length === 0 ? "" : `\n\n${hints.join("\n")}`;
    const footer = `${hint}\n\nControls:\n${rows.join("\n")}`;
    const available = MAX_OUTPUT - header.length - footer.length;
    if (available < 0) return undefined;
    if (offset >= markdown.length) {
        const notice = `\n\nShowing characters ${start} to ${start} of ${markdown.length}. Next offset: ${start}.`;
        return notice.length <= available ? `${header}${notice}${footer}` : undefined;
    }
    if (markdown.length - start <= available) return `${header}${markdown.slice(start)}${footer}`;

    let end = start + available;
    let notice = "";
    for (;;) {
        notice = `\n\nShowing characters ${start} to ${end} of ${markdown.length}. Next offset: ${end}.`;
        const next = start + Math.max(0, available - notice.length);
        if (next >= end) break;
        end = next;
    }
    if (end > start && end < markdown.length
        && /[\uD800-\uDBFF]/.test(markdown[end - 1]!) && /[\uDC00-\uDFFF]/.test(markdown[end]!)) {
        end--;
        notice = `\n\nShowing characters ${start} to ${end} of ${markdown.length}. Next offset: ${end}.`;
    }
    if (end <= start || notice.length > available) return undefined;
    return `${header}${markdown.slice(start, end)}${notice}${footer}`;
}

function readSettings(path: string): BrowserSettings {
    try {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (isRecord(value)) return { enabled: value.enabled === true, offBehavior: value.offBehavior === "refuse" ? "refuse" : "ask" };
    } catch {}
    return { enabled: false, offBehavior: "ask" };
}

function browserToolsOff(text = BROWSER_TOOLS_OFF_TEXT): VeraExtensionToolResult {
    return {
        output: text,
        isError: true,
        presentation: { kind: "tool_notice", text, action: "open_browser" },
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
