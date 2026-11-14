import { useCallback, useEffect, useRef, useState } from "react";

import type { BrowserBounds, BrowserState } from "./native-types.ts";

const EMPTY: BrowserState = { tabs: [], active: null, toolsEnabled: false, toolsAvailable: false };

export function useNativeBrowser(visible: boolean) {
    const [state, setState] = useState<BrowserState>(EMPTY);
    const [error, setError] = useState<string | undefined>();
    const [clearing, setClearing] = useState(false);
    const surface = useRef<HTMLDivElement>(null);
    const command = useCallback(async (name: string, value?: string | number | boolean | null | BrowserBounds) => {
        if (name === "forget") setClearing(true);
        try {
            const next = await window.veraDesktop?.browser(name, value);
            if (next !== undefined) setState(next);
            if (name === "forget") setError(undefined);
        } catch {
            if (name === "forget") setError("Could not forget browsing data.");
        } finally {
            if (name === "forget") setClearing(false);
        }
    }, []);

    useEffect(() => {
        void command("state");
        const timer = window.setInterval(() => void command("state"), 500);
        return () => window.clearInterval(timer);
    }, [command]);

    useEffect(() => {
        let frame = 0;
        let last = "";
        const send = (bounds: BrowserBounds | null): void => {
            const key = JSON.stringify(bounds);
            if (key !== last) {
                last = key;
                void command("bounds", bounds);
            }
        };
        const update = (): void => {
            window.cancelAnimationFrame(frame);
            frame = window.requestAnimationFrame(() => {
                const element = surface.current;
                const overlay = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="menu"], [role="listbox"], .sheet-scrim, .wizard-scrim, [data-popover]')]
                    .some((node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden");
                if (!visible || state.active === null || element === null || overlay) {
                    send(null);
                    return;
                }
                const rect = element.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) {
                    send(null);
                    return;
                }
                send({ x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: rect.width, height: rect.height });
            });
        };
        const observer = new MutationObserver(update);
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden"] });
        const resize = new ResizeObserver(update);
        if (surface.current !== null) resize.observe(surface.current);
        window.addEventListener("resize", update);
        update();
        return () => {
            observer.disconnect();
            resize.disconnect();
            window.removeEventListener("resize", update);
            window.cancelAnimationFrame(frame);
            void command("bounds", null);
        };
    }, [visible, state.active, command]);

    return { state, surface, command, error, clearing };
}
