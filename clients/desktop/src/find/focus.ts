export interface FocusFrame {
    isDestroyed(): boolean;
    executeJavaScript(source: string): Promise<unknown>;
}

const FOCUS_WAIT_MS = 250;

function rememberSource(token: number, deadline: number): string {
    return `(() => {
        if (Date.now() > ${deadline}) return false;
        const key = Symbol.for("vera.windowFind.focus");
        let element = document.activeElement;
        while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
        if (!element || element === document.body || element === document.documentElement) return false;
        globalThis[key] = { token: ${token}, element: new WeakRef(element) };
        return true;
    })()`;
}

function finishSource(token: number, restore: boolean): string {
    return `(() => {
        const key = Symbol.for("vera.windowFind.focus");
        const saved = globalThis[key];
        if (!saved || saved.token !== ${token}) return;
        delete globalThis[key];
        const element = saved.element.deref();
        if (${restore} && element?.isConnected && typeof element.focus === "function") element.focus({ preventScroll: true });
    })()`;
}

export async function rememberFocus(frame: FocusFrame, token: number): Promise<boolean> {
    if (frame.isDestroyed()) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const request = frame.executeJavaScript(rememberSource(token, Date.now() + FOCUS_WAIT_MS));
        const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), FOCUS_WAIT_MS); });
        const remembered = await Promise.race([request.then((result) => result === true), timeout]);
        if (!remembered) void request.then(() => finishFocus(frame, token, false)).catch(() => {});
        return remembered;
    } catch {
        return false;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

export async function finishFocus(frame: FocusFrame, token: number, restore: boolean): Promise<void> {
    if (frame.isDestroyed()) return;
    try {
        await frame.executeJavaScript(finishSource(token, restore));
    } catch {
        // The frame can navigate while the find bar is open.
    }
}
