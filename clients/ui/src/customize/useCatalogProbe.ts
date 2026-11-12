import { useEffect, useState } from "react";

import type { DesktopBridge, SessionPane } from "../protocol/bridge.ts";
import { IDLE_PROBE, probeFailed, probeIds, reduceProbe, startProbe, type ProbeState } from "./probe.ts";
import { listAgentsCommand, listSkillsCommand, listSourcesCommand, parseCatalogLine, type CatalogReply } from "./wire.ts";

const PROBE_PANE: SessionPane = "probe";
const PROBE_TIMEOUT_MS = 15_000;

let probeCount = 0;

function attachOutcome(text: string): "attached" | "failed" | undefined {
    try {
        const value: unknown = JSON.parse(text);
        if (typeof value !== "object" || value === null) return undefined;
        const type = (value as { type?: unknown }).type;
        if (type === "attached") return "attached";
        return type === "attach_failed" ? "failed" : undefined;
    } catch {
        return undefined;
    }
}

// Attaches the probe pane to one session, asks for its skills, agents and sources, and
// detaches once all three answered. `reload` reads again when it changes.
export function useCatalogProbe(
    bridge: DesktopBridge | undefined,
    agentId: string | undefined,
    connected: boolean,
    reload: number,
): ProbeState {
    const [state, setState] = useState<ProbeState>(IDLE_PROBE);
    useEffect(() => {
        if (bridge === undefined || agentId === undefined || !connected) {
            setState(IDLE_PROBE);
            return undefined;
        }
        probeCount += 1;
        const ids = probeIds(`${Date.now().toString(36)}-${probeCount}`);
        let current = startProbe(agentId);
        let done = false;
        setState(current);
        const finish = (next: ProbeState): void => {
            current = next;
            setState(next);
            if (next.phase === "loading" || done) return;
            done = true;
            bridge.unwatchSession(PROBE_PANE);
        };
        const timer = setTimeout(() => finish(probeFailed(current, "The session did not list its customizations in time.")), PROBE_TIMEOUT_MS);
        const off = bridge.onEvent((event) => {
            if (event.type !== "session_frame" && event.type !== "session_closed") return;
            if (event.pane !== PROBE_PANE || event.agentId !== agentId || done) return;
            if (event.type === "session_closed") {
                finish(probeFailed(current, event.reason));
                return;
            }
            const outcome = attachOutcome(event.text);
            if (outcome === "attached") {
                bridge.sendSession(PROBE_PANE, listSkillsCommand(ids.skills));
                bridge.sendSession(PROBE_PANE, listAgentsCommand(ids.agents));
                bridge.sendSession(PROBE_PANE, listSourcesCommand(ids.sources));
                return;
            }
            if (outcome === "failed") {
                finish(probeFailed(current, "Vera could not open that session to read its customizations."));
                return;
            }
            const reply: CatalogReply | undefined = parseCatalogLine(event.text);
            if (reply !== undefined) finish(reduceProbe(current, ids, reply));
        });
        bridge.watchSession(PROBE_PANE, agentId);
        return () => {
            clearTimeout(timer);
            off();
            if (!done) bridge.unwatchSession(PROBE_PANE);
        };
    }, [bridge, agentId, connected, reload]);
    return state;
}
