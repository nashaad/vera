import { useEffect, useState } from "react";

import { useRouter } from "../pages/router.tsx";
import { sessionPlace } from "../pages/routes.ts";
import { useViewEnvironment } from "../views/env.tsx";
import { offerDraft } from "./drafts.ts";

interface Reopen {
    readonly agentId: string;
    readonly draft?: string;
}

// Opens the session the last window showed once the session list carries it, with the text its composer held.
// A session outside the first page is not reopened.
export function ReopenSession(): null {
    const { navigate } = useRouter();
    const { connection } = useViewEnvironment();
    const [pending, setPending] = useState<Reopen | undefined>();
    useEffect(() => window.veraDesktop?.onEvent((event) => {
        if (event.type === "reopen_session") setPending({ agentId: event.agentId, ...(event.draft === undefined ? {} : { draft: event.draft }) });
    }), []);
    const rows = connection.sessionRows;
    useEffect(() => {
        if (pending === undefined || rows === undefined) return;
        setPending(undefined);
        const row = rows.find((candidate) => candidate.id === pending.agentId);
        if (row === undefined) return;
        if (pending.draft !== undefined) offerDraft(row.id, pending.draft);
        navigate({ kind: "session", agentId: row.id, title: row.name, ...sessionPlace(row.workspace, row.chat) });
    }, [pending, rows, navigate]);
    return null;
}
