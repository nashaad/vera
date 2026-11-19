import type { DesktopEvent } from "../protocol/bridge.ts";
import type { HostIdentityFacts } from "../protocol/client.ts";
import { hostRestartingBuild } from "../session/wire.ts";

export type RestartStep =
    | { readonly kind: "announced"; readonly buildId: string }
    | { readonly kind: "reconnect" }
    | { readonly kind: "none" };

// Follows the host's restart notice. The notice arrives on a watch connection, and the host closes
// every connection right after it, so the first loss seen after a notice is the restart itself.
export class PlannedRestartWatch {
    private readonly announcedPanes = new Set<string>();

    observe(event: DesktopEvent): RestartStep {
        if (event.type === "session_frame") {
            const buildId = hostRestartingBuild(event.text);
            if (buildId === undefined) return { kind: "none" };
            this.announcedPanes.add(event.pane);
            return { kind: "announced", buildId };
        }
        if (this.announcedPanes.size === 0) return { kind: "none" };
        if (event.type === "session_closed" && this.announcedPanes.has(event.pane)) return this.fire();
        if (event.type === "disconnected") return this.fire();
        return { kind: "none" };
    }

    // The poll saw the host stop answering.
    lost(): RestartStep {
        return this.announcedPanes.size === 0 ? { kind: "none" } : this.fire();
    }

    // A new host, a failure or a manual reconnect ends the wait.
    clear(): void {
        this.announcedPanes.clear();
    }

    private fire(): RestartStep {
        this.announcedPanes.clear();
        return { kind: "reconnect" };
    }
}

// A host of another build now answers at the same socket. With no session open the window never saw a
// restart notice, so this is the only sign the pair is mixed.
export function replacedBuild(readyBuild: string | null | undefined, identity: HostIdentityFacts): string | undefined {
    const now = identity.build_id;
    if (typeof readyBuild !== "string" || typeof now !== "string" || now === readyBuild) return undefined;
    return now;
}
