import { useCallback, useEffect, useRef, useState } from "react";

import type { DesktopBridge } from "../protocol/bridge.ts";
import type { MoveSessionOutcome } from "../protocol/sessionMove.ts";
import { moveRefusalNotice } from "./rules.ts";

export interface MoveToFolder {
    // True from the click until the host answers; a second move cannot start meanwhile.
    readonly moving: boolean;
    // The refusal of the last move, until the next one starts.
    readonly problem: string | undefined;
    readonly run: () => void;
}

const FAILED: MoveSessionOutcome = { status: "rejected", reason: "failed" };

// Picks a folder in the shell and moves one session there. `onMoved` runs once the host has moved it.
export function useMoveToFolder(bridge: DesktopBridge, agentId: string, onMoved: () => void): MoveToFolder {
    const [moving, setMoving] = useState(false);
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const running = useRef(false);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    const run = useCallback(() => {
        if (running.current) return;
        running.current = true;
        setMoving(true);
        setProblem(undefined);
        bridge.moveSession(agentId).catch(() => FAILED).then((outcome) => {
            running.current = false;
            if (!mounted.current) return;
            setMoving(false);
            if (outcome.status === "moved") onMoved();
            else if (outcome.status === "rejected") setProblem(moveRefusalNotice(outcome.reason));
        });
    }, [bridge, agentId, onMoved]);
    return { moving, problem, run };
}
