import { useEffect, useState } from "react";

import type { DesktopBridge } from "../protocol/bridge.ts";

interface Checked {
    readonly folder: string;
    readonly missing: boolean;
}

// True once the shell has said the session's folder no longer exists. The folder is checked when
// it is opened and each time the window is shown or focused again, not on a timer. A chat has no
// folder of its own to lose, and a failed check says nothing.
export function useFolderMissing(bridge: DesktopBridge, folder: string | undefined, chat: boolean): boolean {
    const [checked, setChecked] = useState<Checked | undefined>(undefined);
    const watched = chat ? undefined : folder;
    useEffect(() => {
        if (watched === undefined || watched === "") return undefined;
        let live = true;
        let latest = 0;
        const check = (): void => {
            const round = ++latest;
            bridge.existingFolders([watched]).then(
                (existing) => {
                    if (live && round === latest) setChecked({ folder: watched, missing: !existing.includes(watched) });
                },
                () => {},
            );
        };
        check();
        const onVisible = (): void => {
            if (document.visibilityState === "visible") check();
        };
        const off = bridge.onEvent((event) => {
            if (event.type === "window_shown" && event.shown) check();
        });
        window.addEventListener("focus", check);
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            live = false;
            off();
            window.removeEventListener("focus", check);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [bridge, watched]);
    return checked !== undefined && checked.folder === watched && checked.missing;
}
