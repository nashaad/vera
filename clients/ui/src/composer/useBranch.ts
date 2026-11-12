import { useEffect, useState } from "react";

import type { DesktopBridge } from "../protocol/bridge.ts";

interface BranchState {
    readonly folder: string;
    readonly name: string | undefined;
}

// The branch of a folder's repository; undefined while loading, when there is none, or for another folder.
export function useBranch(bridge: DesktopBridge | undefined, folder: string | undefined): string | undefined {
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
    return state !== undefined && state.folder === folder ? state.name : undefined;
}
