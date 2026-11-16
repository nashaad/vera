import { useEffect, useState } from "react";

import type { DesktopBridge } from "../protocol/bridge.ts";
import type { NewSessionAgents } from "./newAgent.ts";

// Reads the agents a new session would offer for the folder, again whenever the folder changes.
// Undefined until the host answers, and for a host that has no such request or fails to answer.
export function useNewSessionAgents(bridge: DesktopBridge, folder: string | undefined, attached: boolean): NewSessionAgents | undefined {
    const [listing, setListing] = useState<NewSessionAgents | undefined>(undefined);

    useEffect(() => {
        if (!attached) return undefined;
        let live = true;
        void bridge.readNewSessionAgents(folder).then(
            (result) => {
                if (!live) return;
                setListing(result.ok ? { folder, startsOn: result.startsOn, agents: result.agents, notices: result.notices } : undefined);
            },
            () => {
                if (live) setListing(undefined);
            },
        );
        return () => {
            live = false;
        };
    }, [bridge, folder, attached]);

    return listing;
}
