import { useState } from "react";

import type { DesktopBridge } from "../protocol/bridge.ts";

export interface StopSubagent {
    readonly stopping: ReadonlySet<string>;
    // Why the host would not stop a subagent, by its session id.
    readonly failures: Readonly<Record<string, string>>;
    readonly stop: (id: string) => Promise<void>;
}

// Closes a subagent's session on the host and keeps the answer for the button that asked.
export function useStopSubagent(bridge: DesktopBridge): StopSubagent {
    const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
    const [failures, setFailures] = useState<Readonly<Record<string, string>>>({});
    const stop = async (id: string): Promise<void> => {
        setStopping((current) => new Set(current).add(id));
        setFailures((current) => {
            const next = { ...current };
            delete next[id];
            return next;
        });
        const result = await bridge.closeSession(id);
        setStopping((current) => {
            const next = new Set(current);
            next.delete(id);
            return next;
        });
        if (!result.ok) setFailures((current) => ({ ...current, [id]: result.reason }));
    };
    return { stopping, failures, stop };
}
