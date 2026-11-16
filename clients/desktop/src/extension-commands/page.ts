import type { WebContents } from "electron";

import type { ExtensionCommandResult } from "../../../ui/src/protocol/extension-commands.ts";
import { savePastedImage } from "../pasted-image.ts";
import { parsePageResult, type PageRectangle } from "./page-result.ts";

const WORLD_ID = 1004;
const CLEANUP = "globalThis.__veraPageCleanup?.(); delete globalThis.__veraPageCleanup; delete globalThis.__veraPageResult";

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

async function isolatedWorld(contents: WebContents, frame?: FrameSurface): Promise<PageWorld> {
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
    try {
        const tree = await api.sendCommand("Page.getFrameTree") as { frameTree: FrameTree };
        let target = tree.frameTree.childFrames?.find((child) => child.frame.url === frame.url && child.frame.name === frame.name);
        let sessionId: string | undefined;
        if (target === undefined) {
            const targets = await api.sendCommand("Target.getTargets") as { targetInfos: readonly { type: string; url: string; targetId: string }[] };
            for (const candidate of targets.targetInfos.filter((entry) => entry.type === "iframe" && entry.url === frame.url).slice(0, 32)) {
                const attached = await api.sendCommand("Target.attachToTarget", { targetId: candidate.targetId, flatten: true }) as { sessionId: string };
                const child = await api.sendCommand("Page.getFrameTree", {}, attached.sessionId) as { frameTree: FrameTree };
                if (child.frameTree.frame.url === frame.url && child.frameTree.frame.name === frame.name) {
                    target = child.frameTree;
                    sessionId = attached.sessionId;
                    break;
                }
                await api.sendCommand("Target.detachFromTarget", { sessionId: attached.sessionId });
            }
        }
        if (target === undefined) throw new Error("The page could not be read.");
        const world = await api.sendCommand("Page.createIsolatedWorld", { frameId: target.frame.id, worldName: "vera-page-command" }, sessionId) as { executionContextId: number };
        return {
            run: async (expression) => {
                const reply = await api.sendCommand("Runtime.evaluate", { contextId: world.executionContextId, expression, awaitPromise: true, returnByValue: true }, sessionId) as { result?: { value?: unknown }; exceptionDetails?: unknown };
                if (reply.exceptionDetails !== undefined) throw new Error("The page could not be read.");
                return reply.result?.value;
            },
            release: () => { if (api.isAttached()) api.detach(); },
            offset: frame,
        };
    } catch (error) {
        if (api.isAttached()) api.detach();
        throw error;
    }
}

export class PageCommandService {
    private cancel: (() => void) | undefined;

    stop(): void {
        this.cancel?.();
    }

    async run(script: string, contents: WebContents, directory: string, frame?: FrameSurface): Promise<ExtensionCommandResult> {
        if (this.cancel !== undefined) return { ok: true, kind: "closed" };
        let wasCanceled = false;
        let cancel!: () => void;
        const canceled = new Promise<null>((resolve) => { cancel = () => { wasCanceled = true; resolve(null); }; });
        this.cancel = cancel;
        let world: PageWorld | undefined;
        const navigation = (): void => cancel();
        contents.on("did-start-navigation", navigation);
        contents.once("destroyed", cancel);
        try {
            world = await isolatedWorld(contents, frame);
            const value = await Promise.race([world.run(`${script}\n;globalThis.__veraPageResult`), canceled]);
            if (value === null) return { ok: true, kind: "closed" };
            const result = parsePageResult(value);
            if (result === undefined || contents.isDestroyed()) throw new Error("The page could not be read.");
            const { x, y, width, height } = result.rect;
            if (x + width > world.offset.width || y + height > world.offset.height) throw new Error("The page could not be read.");
            const rect = { x: Math.ceil(x + world.offset.x), y: Math.ceil(y + world.offset.y), width: Math.floor(width), height: Math.floor(height) };
            const image = await contents.capturePage(rect, { stayHidden: true, stayAwake: true });
            if (wasCanceled) return { ok: true, kind: "closed" };
            const path = await savePastedImage(directory, image.toPNG(), "image/png");
            if (path === undefined) throw new Error("Could not attach this file.");
            if (wasCanceled) return { ok: true, kind: "closed" };
            return { ok: true, kind: "capture", capture: { path, preview: image.resize({ width: Math.min(640, image.getSize().width) }).toDataURL(), text: result.text, ...(result.details === undefined ? {} : { details: result.details }) } };
        } catch {
            return wasCanceled ? { ok: true, kind: "closed" } : { ok: false, reason: "The page could not be read." };
        } finally {
            if (world !== undefined) {
                try { await world.run(CLEANUP); } catch {}
                try { world.release(); } catch {}
            }
            contents.removeListener("did-start-navigation", navigation);
            contents.removeListener("destroyed", cancel);
            if (this.cancel === cancel) this.cancel = undefined;
        }
    }
}

export async function browserFrame(contents: WebContents, allowed: (url: string) => boolean): Promise<FrameSurface | undefined> {
    const frame: unknown = await contents.executeJavaScript("(() => { const f = Array.from(document.querySelectorAll('iframe.browser-frame[name^=browser-]')).find(f => f.clientWidth > 0 && f.clientHeight > 0 && getComputedStyle(f).visibility !== 'hidden'); if (!f) return null; const r = f.getBoundingClientRect(); return {url:f.src,name:f.name,x:r.x+f.clientLeft,y:r.y+f.clientTop,width:f.clientWidth,height:f.clientHeight}; })()");
    if (frame === null || typeof frame !== "object") return undefined;
    const value = frame as Record<string, unknown>;
    if (typeof value.url !== "string" || !allowed(value.url) || typeof value.name !== "string" || value.name.length === 0 || value.name.length > 256) return undefined;
    if (![value.x, value.y, value.width, value.height].every((part) => typeof part === "number" && Number.isFinite(part) && part >= 0 && part <= 10000)) return undefined;
    return value as unknown as FrameSurface;
}
