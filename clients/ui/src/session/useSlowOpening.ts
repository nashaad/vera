import { useEffect, useState } from "react";

import type { SessionWatch } from "./model.ts";
import { watchOpening } from "./transcript.ts";

export const SLOW_OPENING_MS = 500;

// True once a watch has been opening for SLOW_OPENING_MS, so a quick open never flashes its opening text.
export function useSlowOpening(watch: SessionWatch): boolean {
    const opening = watchOpening(watch);
    const [slow, setSlow] = useState(false);
    useEffect(() => {
        setSlow(false);
        if (!opening) return undefined;
        const timer = setTimeout(() => setSlow(true), SLOW_OPENING_MS);
        return () => clearTimeout(timer);
    }, [opening, watch.agentId]);
    return opening && slow;
}
