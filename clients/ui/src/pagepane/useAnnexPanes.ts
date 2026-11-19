import { useEffect, useRef, useState } from "react";

import type { AnnexPagesAnswer } from "../protocol/bridge.ts";
import type { PaneKind } from "../registry/core.ts";
import type { ReadyFacts } from "../state/connection.ts";
import { pageKinds, sameKinds } from "./kinds.ts";

// The annex starts a moment after the host does, so a read that fails is tried again a few times.
const RETRY_DELAYS_MS: readonly number[] = [500, 1_500, 4_000];

// Reads the pages the host's annex serves when the window attaches to a host, and the pane kinds the
// extension pages among them ask for. The kinds array changes only when the set of kinds does.
export function useAnnexPanes(ready: ReadyFacts | undefined): {
    readonly annex: AnnexPagesAnswer | undefined;
    readonly kinds: readonly PaneKind[];
} {
    const [read, setRead] = useState<{ readonly ready: ReadyFacts; readonly annex: AnnexPagesAnswer } | undefined>(undefined);
    const annex = read !== undefined && read.ready === ready ? read.annex : undefined;
    const kinds = useRef<readonly PaneKind[]>([]);

    useEffect(() => {
        const bridge = window.veraDesktop;
        if (ready === undefined || bridge === undefined) return;
        let live = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const read = (attempt: number): void => {
            const retry = (): void => {
                const delay = RETRY_DELAYS_MS[attempt];
                if (live && delay !== undefined) timer = setTimeout(() => read(attempt + 1), delay);
            };
            bridge.readAnnexPages().then(
                (result) => {
                    if (!live) return;
                    if (result.ok) setRead({ ready, annex: result });
                    else retry();
                },
                retry,
            );
        };
        read(0);
        return () => {
            live = false;
            clearTimeout(timer);
        };
    }, [ready]);

    const next = pageKinds(annex?.pages ?? []);
    if (!sameKinds(kinds.current, next)) kinds.current = next;
    return { annex, kinds: kinds.current };
}
