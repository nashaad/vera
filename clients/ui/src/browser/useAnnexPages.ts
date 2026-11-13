import { useCallback, useEffect, useRef, useState } from "react";

import type { AnnexPagesResult, DesktopBridge } from "../protocol/bridge.ts";

// Read when the browser is first shown, again for each new host, and on Reload.
export function useAnnexPages(shown: boolean, hostPid: number | undefined): {
    readonly result: AnnexPagesResult | undefined;
    readonly reload: () => void;
} {
    const [result, setResult] = useState<AnnexPagesResult | undefined>(undefined);
    const [round, setRound] = useState(0);
    const readFor = useRef<string | undefined>(undefined);
    const key = `${hostPid ?? "none"}:${round}`;

    useEffect(() => {
        if (!shown || readFor.current === key) return;
        readFor.current = key;
        const bridge = window.veraDesktop as DesktopBridge | undefined;
        if (bridge === undefined) {
            setResult({ ok: false, reason: "This window has no host bridge." });
            return;
        }
        // Hiding the view does not drop a read in flight; only a newer read replaces it.
        bridge.readAnnexPages().then(
            (next) => {
                if (readFor.current === key) setResult(next);
            },
            () => {
                if (readFor.current === key) setResult({ ok: false, reason: "The host did not answer." });
            },
        );
    }, [shown, key]);

    const reload = useCallback(() => setRound((current) => current + 1), []);
    return { result, reload };
}
