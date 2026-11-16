import { useEffect, useState } from "react";

import { isIncludedExtensionOn } from "../../../../src/extensions/included-state.ts";
import { SIDEKICK_EXTENSION_ID } from "../../../../src/sidekick/branch.ts";
import type { DesktopBridge } from "../protocol/bridge.ts";

// Each read runs one short task process, so an answer is reused for this long.
export const INCLUDED_FRESH_MS = 30_000;

interface Read {
    readonly at: number;
    readonly on: boolean;
}

let last: Read | undefined;
let reading: Promise<boolean> | undefined;

export function forgetSidekickOffered(): void {
    last = undefined;
    reading = undefined;
}

// Whether the extension that offers /btw is on. A read that fails counts as off and is not kept.
export function readSidekickOffered(bridge: DesktopBridge, now: () => number = Date.now): Promise<boolean> {
    if (last !== undefined && now() - last.at < INCLUDED_FRESH_MS) return Promise.resolve(last.on);
    reading ??= bridge.readIncludedExtensions().then(
        (result) => {
            if (!result.ok) return false;
            const on = isIncludedExtensionOn(SIDEKICK_EXTENSION_ID, result.disabled);
            last = { at: now(), on };
            return on;
        },
        () => false,
    ).finally(() => {
        reading = undefined;
    });
    return reading;
}

// Undefined until the first read answers. Reads when `wanted` turns true, so the menu is right by the time it opens.
export function useSidekickOffered(bridge: DesktopBridge | undefined, wanted: boolean): boolean | undefined {
    const [offered, setOffered] = useState<boolean | undefined>(undefined);
    useEffect(() => {
        if (!wanted || bridge === undefined) return undefined;
        let live = true;
        void readSidekickOffered(bridge).then((on) => {
            if (live) setOffered(on);
        });
        return () => {
            live = false;
        };
    }, [bridge, wanted]);
    return offered;
}
