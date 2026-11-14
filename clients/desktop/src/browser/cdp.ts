import type { BrowserRequest } from "../../../../extensions/desktop-browser/arguments.ts";
import { BrowserPane } from "./pane.ts";

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

    async forget(): Promise<void> {
        this.refs.clear();
        this.contextId = undefined;
        this.generation += 1;
        await this.pane.forget();
    }

    async run(request: BrowserRequest): Promise<Record<string, unknown>> {
        if (request.action === "open") {
            if (request.url === undefined) throw new Error("A URL is required.");
            if (this.pane.current() === undefined) {
                if (this.pane.open() === undefined) throw new Error("The browser could not open that URL.");
            }
            this.refs.clear();
            this.contextId = undefined;
            await this.pane.navigate(request.url);
            return { output: `Opened ${request.url}` };
        }
        const contents = this.pane.current();
        if (contents === undefined || contents.isDestroyed()) throw new Error("Open a browser tab first.");
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
                    expression: `(() => { const w = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT); let s = '', n = 0, x; while ((x = w.nextNode()) && n++ < 10000 && s.length < 16000) { const p = x.parentElement; if (p && !['SCRIPT','STYLE','NOSCRIPT'].includes(p.tagName)) s += x.textContent + ' '; } return s.slice(0,16000); })()`,
                    returnByValue: true,
                }) as { result?: { value?: unknown } };
                ensureCurrent();
                this.refs = refs;
                this.contextId = world.executionContextId;
                return { output: `URL: ${contents.getURL()}\nTitle: ${contents.getTitle().slice(0, 300)}\nText: ${String(result.result?.value ?? "")}\nControls:\n${rows.join("\n")}` };
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
}
