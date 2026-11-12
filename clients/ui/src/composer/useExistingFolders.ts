import { useEffect, useState } from "react";

import type { DesktopBridge } from "../protocol/bridge.ts";

const NONE: ReadonlySet<string> = new Set();

// The candidates that still exist as folders. The shell is asked once for each distinct list,
// not on every render; until it answers nothing is known to exist.
export function useExistingFolders(bridge: DesktopBridge, candidates: readonly string[]): ReadonlySet<string> {
    const [found, setFound] = useState<ReadonlySet<string>>(NONE);
    // Paths can hold any character but NUL, so the list is keyed as JSON.
    const key = JSON.stringify(candidates);
    useEffect(() => {
        const folders = JSON.parse(key) as string[];
        if (folders.length === 0) {
            setFound(NONE);
            return undefined;
        }
        let live = true;
        bridge.existingFolders(folders).then(
            (existing) => {
                if (live) setFound(new Set(existing));
            },
            () => {
                if (live) setFound(NONE);
            },
        );
        return () => {
            live = false;
        };
    }, [bridge, key]);
    return found;
}
