import { useEffect, useState } from "react";

import type { DesktopBridge } from "../protocol/bridge.ts";
import { folderReadOutcome, LOADING, NO_ANSWER_REASON, NO_BRIDGE_REASON, type FolderReadState } from "./folderReading.ts";

// Asks the host what a new session in `folder` would load, or in a chat when there is none. `reload` reads again when it changes.
export function useFolderCustomizations(
    bridge: DesktopBridge | undefined,
    folder: string | undefined,
    connected: boolean,
    reload: number,
): FolderReadState {
    const [state, setState] = useState<FolderReadState>(LOADING);
    useEffect(() => {
        if (bridge === undefined) {
            setState({ phase: "failed", reason: NO_BRIDGE_REASON });
            return undefined;
        }
        setState(LOADING);
        if (!connected) return undefined;
        let live = true;
        bridge.readFolderCustomizations(folder).then(
            (result) => {
                if (live) setState(folderReadOutcome(result));
            },
            () => {
                if (live) setState({ phase: "failed", reason: NO_ANSWER_REASON });
            },
        );
        return () => {
            live = false;
        };
    }, [bridge, folder, connected, reload]);
    return state;
}
