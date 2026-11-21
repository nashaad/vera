import type { BrowserRequest } from "../../../../extensions/builtin-browser/arguments.ts";
import { EVAL_NOT_JSON, EVAL_RESULT_LIMIT, EVAL_TIMEOUT_DEFAULT_MS, evalThrew, evalTimedOut } from "../../../../extensions/builtin-browser/eval.ts";
import { BrowserPane } from "./pane.ts";
import { BLOCKED_ANNEX_OPEN_ERROR } from "./origin-guard.ts";

export const NO_WEB_PAGE_ERROR = "No web page is open in the Browser pane. Vera's own pages such as Usage cannot be controlled here. Use open with a URL.";

const READ_PAGE_EXPRESSION = `(() => {
    const html = document.documentElement?.outerHTML ?? '';
    const limit = 2 * 1024 * 1024;
    const bytes = new TextEncoder().encode(html.slice(0, limit));
    const htmlTruncated = html.length > limit || bytes.length > limit;
    let boundedHtml = html;
    if (htmlTruncated) {
        let end = Math.min(bytes.length, limit);
        const decoder = new TextDecoder('utf-8', { fatal: true });
        while (end > 0) {
            try { boundedHtml = decoder.decode(bytes.subarray(0, end)); break; }
            catch { end--; }
        }
        if (end === 0) boundedHtml = '';
    }
    let humanCheck = /cf-challenge|cf_chl_/i.test(html);
    for (const frame of document.querySelectorAll('iframe[src]')) {
        try {
            const url = new URL(frame.src, location.href);
            const host = url.hostname.toLowerCase();
            if (((host === 'google.com' || host.endsWith('.google.com')) && url.pathname.startsWith('/recaptcha/'))
                || host === 'recaptcha.net' || host.endsWith('.recaptcha.net')
                || host === 'hcaptcha.com' || host.endsWith('.hcaptcha.com')
                || host === 'challenges.cloudflare.com') {
                humanCheck = true;
                break;
            }
        } catch {}
    }
    return { html: boundedHtml, htmlTruncated, humanCheck };
})()`;

interface AxNode {
    readonly ignored?: boolean;
    readonly backendDOMNodeId?: number;
    readonly role?: { readonly value?: string };
    readonly name?: { readonly value?: string };
}

export class BrowserCdp {
    private refs = new Map<string, number>();
    private contentsId: number | undefined;
    private nextRef = 1;
    private readonly watched = new WeakSet<Electron.WebContents>();
    private generation = 0;
    private contextId: number | undefined;

    constructor(private readonly pane: BrowserPane) {}

    async run(request: BrowserRequest): Promise<Record<string, unknown>> {
        if (request.action === "open") {
            if (request.url === undefined) throw new Error("A URL is required.");
            if (this.pane.current() === undefined) {
                if (this.pane.open() === undefined) throw new Error("The browser could not open that URL.");
            }
            this.refs.clear();
            this.contextId = undefined;
            try {
                await this.pane.navigate(request.url);
            } catch (error) {
                if (error instanceof Error && /ERR_BLOCKED_BY_CLIENT/.test(error.message)) throw new Error(BLOCKED_ANNEX_OPEN_ERROR);
                throw error;
            }
            return { output: `Opened ${request.url}` };
        }
        const contents = this.pane.current();
        if (contents === undefined || contents.isDestroyed()) throw new Error(NO_WEB_PAGE_ERROR);
        if (this.contentsId !== contents.id) {
            this.refs.clear();
            this.contextId = undefined;
            this.generation += 1;
            this.contentsId = contents.id;
            if (!this.watched.has(contents)) {
                this.watched.add(contents);
                contents.on("did-start-navigation", (_event, _url, _inPlace, mainFrame) => {
                    if (mainFrame && this.contentsId === contents.id) {
                        this.generation += 1;
                        this.refs.clear();
                        this.contextId = undefined;
                    }
                });
            }
        }
        if (request.action === "back") {
            if (!contents.navigationHistory.canGoBack()) throw new Error("There is no previous page.");
            contents.navigationHistory.goBack();
            this.refs.clear();
            this.contextId = undefined;
            return { output: "Went back." };
        }
        const debuggerApi = contents.debugger;
        const generation = this.generation;
        const ensureCurrent = (): void => {
            if (this.pane.current() !== contents || this.generation !== generation) throw new Error("The page changed. Read it again.");
        };
        debuggerApi.attach("1.3");
        try {
            if (request.action === "eval") return await this.evaluate(debuggerApi, request, ensureCurrent);
            if (request.action === "read") {
                this.refs.clear();
                const refs = new Map<string, number>();
                const rows: string[] = [];
                const frame = await debuggerApi.sendCommand("Page.getFrameTree") as { frameTree: { frame: { id: string } } };
                const world = await debuggerApi.sendCommand("Page.createIsolatedWorld", { frameId: frame.frameTree.frame.id, worldName: "vera-browser" }) as { executionContextId: number };
                const candidates = await debuggerApi.sendCommand("Runtime.evaluate", {
                    contextId: world.executionContextId,
                    expression: `(() => { const out = [], w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT); let n = 0, e; while ((e = w.nextNode()) && n++ < 10000 && out.length < 150) { if (e.matches('a[href],button,input:not([type=hidden]),textarea,select,[contenteditable=true],[tabindex],[role=button],[role=link],[role=textbox],[role=checkbox],[role=combobox],[role=menuitem]') && e.getClientRects().length) out.push(e); } return out; })()`,
                    objectGroup: "vera-browser",
                }) as { result?: { objectId?: string } };
                if (candidates.result?.objectId === undefined) throw new Error("The page could not be read.");
                const properties = await debuggerApi.sendCommand("Runtime.getProperties", { objectId: candidates.result.objectId, ownProperties: true }) as { result: { name: string; value?: { objectId?: string } }[] };
                const objects = properties.result.filter((property) => /^\d+$/.test(property.name) && property.value?.objectId !== undefined).slice(0, 150);
                for (let at = 0; at < objects.length; at += 20) {
                    const batch = await Promise.all(objects.slice(at, at + 20).map(async (property) => {
                        try {
                            const tree = await debuggerApi.sendCommand("Accessibility.getPartialAXTree", { objectId: property.value!.objectId, fetchRelatives: false }) as { nodes: AxNode[] };
                            return tree.nodes.find((node) => !node.ignored && node.backendDOMNodeId !== undefined);
                        } catch { return undefined; }
                    }));
                    for (const node of batch) {
                        if (node?.backendDOMNodeId === undefined) continue;
                        const role = String(node.role?.value ?? "").slice(0, 80);
                        const name = String(node.name?.value ?? "").replace(/\s+/g, " ").slice(0, 250);
                        const ref = `r${this.nextRef++}`;
                        refs.set(ref, node.backendDOMNodeId);
                        rows.push(`${ref} ${role} ${name}`.trim());
                    }
                }
                await debuggerApi.sendCommand("Runtime.releaseObjectGroup", { objectGroup: "vera-browser" });
                const result = await debuggerApi.sendCommand("Runtime.evaluate", {
                    contextId: world.executionContextId,
                    expression: READ_PAGE_EXPRESSION,
                    returnByValue: true,
                }) as { result?: { value?: { html?: unknown; htmlTruncated?: unknown; humanCheck?: unknown } } };
                ensureCurrent();
                this.refs = refs;
                this.contextId = world.executionContextId;
                return {
                    url: contents.getURL(),
                    title: contents.getTitle().slice(0, 300),
                    html: String(result.result?.value?.html ?? ""),
                    htmlTruncated: result.result?.value?.htmlTruncated === true,
                    controls: rows,
                    humanCheck: result.result?.value?.humanCheck === true,
                };
            }
            if (request.action === "screenshot") {
                const image = await debuggerApi.sendCommand("Page.captureScreenshot", { format: "jpeg", quality: 60 }) as { data: string };
                ensureCurrent();
                return { image: image.data };
            }
            if (request.action === "scroll") {
                ensureCurrent();
                await debuggerApi.sendCommand("Input.synthesizeScrollGesture", { x: 100, y: 100, yDistance: -(request.amount ?? 600), speed: 1200 });
                return { output: "Scrolled." };
            }
            const node = request.ref === undefined ? undefined : this.refs.get(request.ref);
            if (node === undefined || this.contextId === undefined) throw new Error("That ref is stale. Read the page again.");
            await debuggerApi.sendCommand("DOM.scrollIntoViewIfNeeded", { backendNodeId: node });
            const box = await debuggerApi.sendCommand("DOM.getBoxModel", { backendNodeId: node }) as { model: { content: number[] } };
            const points = box.model.content;
            const x = (points[0]! + points[2]! + points[4]! + points[6]!) / 4;
            const y = (points[1]! + points[3]! + points[5]! + points[7]!) / 4;
            const resolved = await debuggerApi.sendCommand("DOM.resolveNode", { backendNodeId: node, executionContextId: this.contextId }) as { object: { objectId: string } };
            const hit = await debuggerApi.sendCommand("Runtime.callFunctionOn", {
                objectId: resolved.object.objectId,
                functionDeclaration: "function(x,y) { const e = document.elementFromPoint(x,y), c = e && e.closest('button,a,input,textarea,select,[role=button],[role=link]'); return !!e && (e === this || this.contains(e)) && (!c || c === this || !this.contains(c)) && !this.disabled && !this.closest('[aria-disabled=true]'); }",
                arguments: [{ value: x }, { value: y }], returnByValue: true,
            }) as { result?: { value?: unknown } };
            if (hit.result?.value !== true) throw new Error("The target is hidden, covered, or disabled.");
            ensureCurrent();
            if (request.action === "type") {
                const editable = await debuggerApi.sendCommand("Runtime.callFunctionOn", {
                    objectId: resolved.object.objectId,
                    functionDeclaration: "function() { const s = getComputedStyle(this); return (this.matches('input:not([type=hidden]), textarea') || this.isContentEditable) && !this.disabled && !this.readOnly && s.display !== 'none' && s.visibility !== 'hidden'; }",
                    returnByValue: true,
                }) as { result?: { value?: unknown } };
                if (editable.result?.value !== true) throw new Error("The target is not an editable field.");
                ensureCurrent();
                await debuggerApi.sendCommand("DOM.focus", { backendNodeId: node });
                ensureCurrent();
                const focused = await debuggerApi.sendCommand("Runtime.callFunctionOn", {
                    objectId: resolved.object.objectId,
                    functionDeclaration: "function() { return document.activeElement === this || this.contains(document.activeElement); }",
                    returnByValue: true,
                }) as { result?: { value?: unknown } };
                if (focused.result?.value !== true) throw new Error("The field could not be focused.");
                ensureCurrent();
                await debuggerApi.sendCommand("Input.insertText", { text: request.text ?? "" });
                return { output: "Typed." };
            }
            await debuggerApi.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
            await debuggerApi.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
            return { output: "Clicked." };
        } finally {
            if (debuggerApi.isAttached()) debuggerApi.detach();
        }
    }

    // The script is wrapped so a thrown value and a value JSON cannot hold come back as tagged data, not a failed command.
    private async evaluate(
        debuggerApi: DebuggerApi,
        request: BrowserRequest,
        ensureCurrent: () => void,
    ): Promise<Record<string, unknown>> {
        const timeoutMs = request.timeout_ms ?? EVAL_TIMEOUT_DEFAULT_MS;
        const frame = await debuggerApi.sendCommand("Page.getFrameTree") as { frameTree: { frame: { id: string } } };
        const world = await debuggerApi.sendCommand("Page.createIsolatedWorld", { frameId: frame.frameTree.frame.id, worldName: "vera-browser" }) as { executionContextId: number };
        const expression = `(async () => {
    let value;
    try {
        value = await (async () => {
${request.script ?? ""}
        })();
    } catch (error) {
        return { kind: "threw", message: error !== null && typeof error === "object" && typeof error.message === "string" ? error.message : String(error) };
    }
    let json;
    try { json = JSON.stringify(value); } catch { return { kind: "notJson" }; }
    if (typeof json !== "string") return { kind: "notJson" };
    return { kind: "json", json: json.slice(0, ${EVAL_RESULT_LIMIT}), total: json.length };
})()`;
        const evaluation = debuggerApi.sendCommand("Runtime.evaluate", {
            contextId: world.executionContextId,
            expression,
            awaitPromise: true,
            returnByValue: true,
            timeout: timeoutMs + 1000,
        }) as Promise<EvaluateResponse>;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const outcome = await Promise.race([
                evaluation.then((response) => ({ kind: "done" as const, response })),
                new Promise<{ kind: "timeout" }>((resolve) => {
                    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
                }),
            ]);
            if (outcome.kind === "timeout") {
                void debuggerApi.sendCommand("Runtime.terminateExecution").catch(() => undefined);
                return { error: evalTimedOut(timeoutMs) };
            }
            ensureCurrent();
            const details = outcome.response.exceptionDetails;
            if (details !== undefined) return { error: evalThrew(exceptionMessage(details)) };
            const value = outcome.response.result?.value;
            if (!isRecord(value)) return { error: EVAL_NOT_JSON };
            if (value.kind === "threw" && typeof value.message === "string") return { error: evalThrew(value.message) };
            if (value.kind === "json" && typeof value.json === "string") {
                return { output: value.json, total: typeof value.total === "number" ? value.total : value.json.length };
            }
            return { error: EVAL_NOT_JSON };
        } finally {
            if (timer !== undefined) clearTimeout(timer);
            void evaluation.catch(() => undefined);
        }
    }
}

interface DebuggerApi {
    attach(protocolVersion: string): void;
    detach(): void;
    isAttached(): boolean;
    sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

interface EvaluateResponse {
    readonly result?: { readonly value?: unknown };
    readonly exceptionDetails?: {
        readonly text?: string;
        readonly exception?: { readonly description?: string; readonly value?: unknown };
    };
}

function exceptionMessage(details: NonNullable<EvaluateResponse["exceptionDetails"]>): string {
    const description = details.exception?.description;
    if (typeof description === "string") return (description.split("\n")[0] ?? description).replace(/^[A-Za-z]*Error: /, "");
    if (typeof details.exception?.value === "string") return details.exception.value;
    return details.text ?? "Unknown error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
