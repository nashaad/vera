import { useEffect, useState } from "react";

import type { DesktopBridge } from "../protocol/bridge.ts";

interface BranchState {
    readonly folder: string;
    readonly name: string | undefined;
}

export interface BranchLookup {
    readonly done: boolean;
    readonly name: string | undefined;
}

// Tells a folder with no repository apart from one still being read.
export function useBranchLookup(bridge: DesktopBridge | undefined, folder: string | undefined): BranchLookup {
    const [state, setState] = useState<BranchState | undefined>(undefined);
    useEffect(() => {
        if (bridge === undefined || folder === undefined) return undefined;
        let live = true;
        bridge
            .readBranch(folder)
            .catch(() => undefined)
            .then((name) => {
                if (live) setState({ folder, name });
            });
        return () => {
            live = false;
        };
    }, [bridge, folder]);
    if (state === undefined || state.folder !== folder) return { done: false, name: undefined };
    return { done: true, name: state.name };
}

// The branch of a folder's repository; undefined while loading, when there is none, or for another folder.
export function useBranch(bridge: DesktopBridge | undefined, folder: string | undefined): string | undefined {
    return useBranchLookup(bridge, folder).name;
}
