import { chmodSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { VeraExtensionApi, VeraExtensionToolResult } from "../../src/sdk/extensions.ts";
import type { JsonValue } from "../../src/sdk/hooks.ts";
import { parseBrowserRequest, type BrowserRequest } from "./arguments.ts";
import { EVAL_DESCRIPTION, EVAL_RESULT_LIMIT, EVAL_SCRIPT_LIMIT, EVAL_TIMEOUT_LIMIT_MS, evalCut } from "./eval.ts";
import { BROWSER_TOOLS_OFF, BROWSER_TOOLS_OFF_TEXT } from "./failure.ts";

const DESCRIPTION = "Use the built-in browser, the Browser pane in the Vera desktop window. Open an http or https URL, read the page as markdown with link URLs and tables plus accessibility refs, click or type by ref, scroll, go back, or take a screenshot. Read the page before using refs. A long page is cut: read again with the offset the reply gives to continue. If the page shows a CAPTCHA or another human check, use handoff with a short reason so the user can complete it in the pane, then read the page again. Never try to solve a human check yourself. It cannot control Vera's own pages such as Usage. If a tool named browser is also available, ask the user once which browser to use before the first call, and keep the answer for this conversation.";
const MAX_IMAGE = 800_000;
const MAX_PENDING = 8;
const MAX_OUTPUT = 30_000;
const MAX_CONTROLS = 10_000;
const MAX_MARKDOWN = 10_000_000;
const MAX_URL = 8192;
const MAX_TITLE = 300;

interface Job {
    readonly id: string;
    readonly request: BrowserRequest;
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
                job.finish({ error: BROWSER_TOOLS_OFF_TEXT, errorCode: BROWSER_TOOLS_OFF });
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

    vera.tools.register({
        name: "builtin_browser",
        description: DESCRIPTION,
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["open", "read", "click", "type", "scroll", "back", "screenshot"] },
                url: { type: "string" }, ref: { type: "string" }, text: { type: "string" }, amount: { type: "number" },
                offset: { type: "integer", minimum: 0, maximum: 10_000_000 },
            },
            required: ["action"], additionalProperties: false,
        },
        permissionOperation: "desktop.browser",
        parallel: false,
        timeoutMs: 30_000,
        run: async ({ input, signal }): Promise<VeraExtensionToolResult> => {
            const request = parseBrowserRequest(input);
            if (request === undefined || request.action === "eval") return { output: "Invalid browser request.", isError: true };
            if (!enabled()) return browserToolsOff();
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
        timeoutMs: 30_000,
        run: async ({ input, signal }): Promise<VeraExtensionToolResult> => {
            const request = parseBrowserRequest({ ...input, action: "eval" });
            if (request === undefined) return { output: "Invalid browser request.", isError: true };
            if (!enabled()) return browserToolsOff();
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

function browserToolsOff(): VeraExtensionToolResult {
    return {
        output: BROWSER_TOOLS_OFF_TEXT,
        isError: true,
        presentation: { kind: "tool_notice", text: BROWSER_TOOLS_OFF_TEXT, action: "open_browser" },
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
