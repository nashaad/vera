import type { WebContents } from "electron";

import type { ExtensionCommandResult } from "../../../ui/src/protocol/extension-commands.ts";
import { savePastedImage } from "../pasted-image.ts";
import { parsePageResult, type PageRectangle } from "./page-result.ts";

const WORLD_ID = 1004;
const CLEANUP = "globalThis.__veraPageCleanup?.(); delete globalThis.__veraPageCleanup; delete globalThis.__veraPageResult; delete globalThis.__veraPageNext";

interface FrameIdentity {
    readonly id: string;
    readonly url: string;
    readonly name?: string;
}

interface FrameTree {
    readonly frame: FrameIdentity;
    readonly childFrames?: readonly FrameTree[];
}

interface FrameSurface extends PageRectangle {
    readonly url: string;
    readonly name: string;
}

interface PageWorld {
    readonly run: (code: string) => Promise<unknown>;
    readonly release: () => void;
    readonly offset: PageRectangle;
}

interface ExecutionContext {
    readonly id: number;
    readonly name: string;
    readonly auxData?: { readonly frameId?: string };
}

async function frameWorld(api: Electron.Debugger, frameId: string, sessionId?: string): Promise<number> {
    let existing: number | undefined;
    const created = (_event: Electron.Event, method: string, params: { context?: ExecutionContext }, session?: string): void => {
        const context = params.context;
        if (method === "Runtime.executionContextCreated" && session === sessionId && context?.name === "vera-page-command" && context.auxData?.frameId === frameId) existing = context.id;
    };
    api.on("message", created);
    try {
        await api.sendCommand("Runtime.enable", {}, sessionId);
    } finally {
        api.removeListener("message", created);
    }
    if (existing !== undefined) return existing;
    const world = await api.sendCommand("Page.createIsolatedWorld", { frameId, worldName: "vera-page-command" }, sessionId) as { executionContextId: number };
    return world.executionContextId;
}

function sameOrigin(left: string, right: string): boolean {
    try { const a = new URL(left); const b = new URL(right); return a.protocol === b.protocol && a.host === b.host; } catch { return false; }
}

async function isolatedWorld(contents: WebContents, frame?: FrameSurface, onDetach?: () => void): Promise<PageWorld> {
    if (frame === undefined) {
        return {
            run: (code) => contents.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code }], true),
            release: () => {},
            offset: { x: 0, y: 0, width: 10000, height: 10000 },
        };
    }
    const api = contents.debugger;
    if (api.isAttached()) throw new Error("The page could not be read.");
    api.attach("1.3");
    let detached: ((_event: Electron.Event, method: string, params: { frameId?: string; sessionId?: string }) => void) | undefined;
    try {
        const tree = await api.sendCommand("Page.getFrameTree") as { frameTree: FrameTree };
        let target = tree.frameTree.childFrames?.find((child) => sameOrigin(child.frame.url, frame.url) && child.frame.name === frame.name);
        let sessionId: string | undefined;
        if (target === undefined) {
            const targets = await api.sendCommand("Target.getTargets") as { targetInfos: readonly { type: string; url: string; targetId: string }[] };
            for (const candidate of targets.targetInfos.filter((entry) => entry.type === "iframe" && sameOrigin(entry.url, frame.url)).slice(0, 32)) {
                const attached = await api.sendCommand("Target.attachToTarget", { targetId: candidate.targetId, flatten: true }) as { sessionId: string };
                const child = await api.sendCommand("Page.getFrameTree", {}, attached.sessionId) as { frameTree: FrameTree };
                if (sameOrigin(child.frameTree.frame.url, frame.url) && child.frameTree.frame.name === frame.name) {
                    target = child.frameTree;
                    sessionId = attached.sessionId;
                    break;
                }
                await api.sendCommand("Target.detachFromTarget", { sessionId: attached.sessionId });
            }
        }
        if (target === undefined) throw new Error("The page could not be read.");
        const frameId = target.frame.id;
        await api.sendCommand("Page.enable");
        if (sessionId !== undefined) await api.sendCommand("Page.enable", {}, sessionId);
        detached = (_event: Electron.Event, method: string, params: { frameId?: string; sessionId?: string }): void => {
            if ((method === "Page.frameDetached" && params.frameId === frameId) || (method === "Target.detachedFromTarget" && sessionId !== undefined && params.sessionId === sessionId)) onDetach?.();
        };
        api.on("message", detached);
        const contextId = await frameWorld(api, frameId, sessionId);
        return {
            run: async (expression) => {
                const reply = await api.sendCommand("Runtime.evaluate", { contextId, expression, awaitPromise: true, returnByValue: true }, sessionId) as { result?: { value?: unknown }; exceptionDetails?: unknown };
                if (reply.exceptionDetails !== undefined) throw new Error("The page could not be read.");
                return reply.result?.value;
            },
            release: () => { if (detached !== undefined) api.removeListener("message", detached); if (api.isAttached()) api.detach(); },
            offset: frame,
        };
    } catch (error) {
        if (detached !== undefined) api.removeListener("message", detached);
        if (api.isAttached()) api.detach();
        throw error;
    }
}

export class PageCommandService {
    private cancel: (() => void) | undefined;
    private frameName: string | undefined;

    stopFrame(name: string): void {
        if (this.frameName === name) this.stop();
    }

    stop(): void {
        this.cancel?.();
    }

    async run(script: string, contents: WebContents, directory: string, frame?: FrameSurface, emit?: (result: ExtensionCommandResult) => void, source?: (url: string) => Promise<string | undefined>): Promise<ExtensionCommandResult> {
        if (this.cancel !== undefined) return { ok: true, kind: "closed" };
        let wasCanceled = false;
        let frameDetached = false;
        let releaseDetached: (() => void) | undefined;
        const detached = new Promise<void>((resolve) => { releaseDetached = resolve; });
        let wake: (() => void) | undefined;
        const cancel = (): void => { wasCanceled = true; wake?.(); };
        const wait = (pending: Promise<unknown>): Promise<unknown> => new Promise((resolve, reject) => {
            const stop = (): void => resolve(null);
            wake = stop;
            if (wasCanceled) { stop(); return; }
            pending.then((value) => { if (wake === stop) wake = undefined; resolve(value); }, (error) => { if (wake === stop) wake = undefined; reject(error); });
        });
        this.cancel = cancel;
        this.frameName = frame?.name;
        let world: PageWorld | undefined;
        const navigation = (): void => cancel();
        contents.on("did-start-navigation", navigation);
        contents.once("destroyed", cancel);
        try {
            world = await isolatedWorld(contents, frame, () => { frameDetached = true; releaseDetached?.(); cancel(); });
            let pending = world.run(`${script}\n;globalThis.__veraPageResult`);
            while (!wasCanceled) {
                const value = await wait(pending);
                if (value === null || wasCanceled) return { ok: true, kind: "closed" };
                const persistent = await world.run("typeof globalThis.__veraPageNext === 'function'");
                try {
                    const result = parsePageResult(value);
                    if (result === undefined || contents.isDestroyed()) throw new Error("The page could not be read.");
                    let text = result.text;
                    if (source !== undefined) {
                        const location = await world.run("location.href");
                        const path = typeof location === "string" ? await source(location) : undefined;
                        if (path === undefined) throw new Error("The page could not be read.");
                        text = `Local source file: ${path.slice(0, 4096)}\n${text}`.slice(0, 16384);
                    }
                    const { x, y, width, height } = result.rect;
                    if (x + width > world.offset.width || y + height > world.offset.height) throw new Error("The page could not be read.");
                    const rect = { x: Math.ceil(x + world.offset.x), y: Math.ceil(y + world.offset.y), width: Math.floor(width), height: Math.floor(height) };
                    const image = await contents.capturePage(rect, { stayHidden: true, stayAwake: true });
                    if (wasCanceled) return { ok: true, kind: "closed" };
                    const path = await savePastedImage(directory, image.toPNG(), "image/png");
                    if (path === undefined) throw new Error("Could not attach this file.");
                    if (wasCanceled || (persistent && !(await world.run("typeof globalThis.__veraPageNext === 'function'")))) return { ok: true, kind: "closed" };
                    const answer: ExtensionCommandResult = { ok: true, kind: "capture", capture: { path, preview: image.resize({ width: Math.min(640, image.getSize().width) }).toDataURL(), text, ...(result.details === undefined ? {} : { details: result.details }) } };
                    if (emit === undefined || !persistent) return answer;
                    emit(answer);
                } catch {
                    if (wasCanceled) return { ok: true, kind: "closed" };
                    if (emit === undefined) throw new Error("The page could not be read.");
                    emit({ ok: false, reason: "The page could not be read." });
                }
                pending = world.run("globalThis.__veraPageNext?.() ?? null");
            }
            return { ok: true, kind: "closed" };
        } catch {
            return wasCanceled ? { ok: true, kind: "closed" } : { ok: false, reason: "The page could not be read." };
        } finally {
            if (world !== undefined) {
                if (!frameDetached) {
                    try { await Promise.race([world.run(CLEANUP), detached]); } catch {}
                }
                try { world.release(); } catch {}
            }
            contents.removeListener("did-start-navigation", navigation);
            contents.removeListener("destroyed", cancel);
            if (this.cancel === cancel) { this.cancel = undefined; this.frameName = undefined; }
        }
    }
}

export async function browserFrame(contents: WebContents, allowed: (url: string) => boolean, name?: string): Promise<FrameSurface | undefined> {
    if (name !== undefined && (name.length === 0 || name.length > 256)) return undefined;
    const frame: unknown = await contents.executeJavaScript(`(() => { const name = ${JSON.stringify(name ?? null)}; const f = Array.from(document.querySelectorAll('iframe.browser-frame[name]')).find(f => (name === null ? f.name.startsWith('browser-') : f.name === name) && f.clientWidth > 0 && f.clientHeight > 0 && getComputedStyle(f).visibility !== 'hidden'); if (!f) return null; const r = f.getBoundingClientRect(); return {url:f.src,name:f.name,x:r.x+f.clientLeft,y:r.y+f.clientTop,width:f.clientWidth,height:f.clientHeight}; })()`);
    if (frame === null || typeof frame !== "object") return undefined;
    const value = frame as Record<string, unknown>;
    if (typeof value.url !== "string" || !allowed(value.url) || typeof value.name !== "string" || value.name.length === 0 || value.name.length > 256) return undefined;
    if (![value.x, value.y, value.width, value.height].every((part) => typeof part === "number" && Number.isFinite(part) && part >= 0 && part <= 10000)) return undefined;
    const matches = contents.mainFrame.framesInSubtree.filter((candidate) => candidate.name === value.name && sameOrigin(candidate.url, value.url as string));
    if (matches.length !== 1 || !allowed(matches[0]!.url)) return undefined;
    return { ...value, url: matches[0]!.url } as unknown as FrameSurface;
}
