import { useEffect, useRef } from "react";

import { reportEvidence } from "../state/useSurfaces.ts";
import { useActiveSession } from "./activeSession.ts";
import { NO_SESSION_EVIDENCE, readSessionEvidence, type SessionEvidence } from "./evidence.ts";

interface Seen {
    readonly agentId: string | undefined;
    readonly evidence: SessionEvidence;
}

// Reports what the open session has ever had, so a pane that appeared stays while the session is open.
// Drawing nothing keeps this out of the page's own renders.
export function SessionEvidenceReporter(): null {
    const session = useActiveSession();
    const seen = useRef<Seen>({ agentId: undefined, evidence: NO_SESSION_EVIDENCE });
    useEffect(() => {
        const agentId = session?.agentId;
        const base = seen.current.agentId === agentId ? seen.current.evidence : NO_SESSION_EVIDENCE;
        const evidence = session === undefined
            ? NO_SESSION_EVIDENCE
            : readSessionEvidence(session.watch, { folder: session.folder, chat: session.chat }, base);
        seen.current = { agentId, evidence };
        reportEvidence(evidence);
    }, [session]);
    return null;
}
