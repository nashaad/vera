import { useEffect, useSyncExternalStore } from "react";

import { hasFolderSession } from "../customize/catalog.ts";
import type { UiState } from "./connection.ts";
import { FLAG_KEYS, type DesktopFlags, type FlagKey } from "./desktopFlags.ts";
import { useOutputLog, type OutputLog } from "./outputLog.ts";
import { NO_EVIDENCE, resolveVisibility, type SurfaceEvidence, type Visibility } from "./surfaces.ts";
import { currentDesktopFlags, subscribeDesktopFlags } from "./useDesktopFlags.ts";

let evidence: SurfaceEvidence = NO_EVIDENCE;
const listeners = new Set<() => void>();

function changed(next: SurfaceEvidence): boolean {
    return (Object.keys(next) as (keyof SurfaceEvidence)[]).some((key) => next[key] !== evidence[key]);
}

function publish(next: SurfaceEvidence): void {
    if (!changed(next)) return;
    evidence = next;
    for (const listener of listeners) listener();
}

// Sets the fields of the open session, which change when another session opens.
export function reportEvidence(patch: Partial<SurfaceEvidence>): void {
    publish({ ...evidence, ...patch });
}

export type WindowEvidence = Pick<SurfaceEvidence, "sessions" | "folderSession" | "output" | "hostFailed">;

// Turns on what the window has seen; nothing here turns back off until the window closes.
export function raiseEvidence(seen: WindowEvidence): void {
    publish({
        ...evidence,
        sessions: Math.max(evidence.sessions, seen.sessions),
        folderSession: evidence.folderSession || seen.folderSession,
        output: evidence.output || seen.output,
        hostFailed: evidence.hostFailed || seen.hostFailed,
    });
}

export function resetEvidence(): void {
    evidence = NO_EVIDENCE;
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    const stop = subscribeDesktopFlags(listener);
    return () => {
        listeners.delete(listener);
        stop();
    };
}

let cache: { readonly flags: DesktopFlags; readonly evidence: SurfaceEvidence; readonly visible: Visibility } | undefined;

// The same object until a part turns on or off, so a change that moves no part redraws nothing.
export function currentVisibility(): Visibility {
    const flags = currentDesktopFlags();
    if (cache?.flags === flags && cache.evidence === evidence) return cache.visible;
    const next = resolveVisibility(flags, evidence);
    const visible = cache !== undefined && FLAG_KEYS.every((key) => cache?.visible[key] === next[key]) ? cache.visible : next;
    cache = { flags, evidence, visible };
    return visible;
}

export function useVisibility(): Visibility {
    return useSyncExternalStore(subscribe, currentVisibility);
}

// Whether the window shows the part now.
export function useSurface(key: FlagKey): boolean {
    return useSyncExternalStore(subscribe, () => currentVisibility()[key]);
}

// Feeds what the host connection and the connection log show into the window-wide evidence.
export function useWindowEvidence(connection: UiState, log: OutputLog): void {
    const entries = useOutputLog(log);
    const failed = connection.phase === "disconnected" || connection.phase === "failed" || connection.phase === "missing";
    const sessions = connection.sessions ?? 0;
    const folderSession = connection.sessionRows !== undefined && hasFolderSession(connection.sessionRows);
    const noisy = entries.some((entry) => entry.kind !== "info");
    useEffect(() => {
        raiseEvidence({ sessions, folderSession, hostFailed: failed, output: noisy });
    }, [sessions, folderSession, failed, noisy]);
}
