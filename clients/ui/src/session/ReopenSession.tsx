import { useEffect, useState } from "react";

import { useRouter } from "../pages/router.tsx";
import { sessionPlace } from "../pages/routes.ts";
import { useViewEnvironment } from "../views/env.tsx";

// Opens the session the last window showed once the session list carries it. A session outside the first page is not reopened.
export function ReopenSession(): null {
    const { navigate } = useRouter();
    const { connection } = useViewEnvironment();
    const [pending, setPending] = useState<string | undefined>();
    useEffect(() => window.veraDesktop?.onEvent((event) => {
        if (event.type === "reopen_session") setPending(event.agentId);
    }), []);
    const rows = connection.sessionRows;
    useEffect(() => {
        if (pending === undefined || rows === undefined) return;
        setPending(undefined);
        const row = rows.find((candidate) => candidate.id === pending);
        if (row === undefined) return;
        navigate({ kind: "session", agentId: row.id, title: row.name, ...sessionPlace(row.workspace, row.chat) });
    }, [pending, rows, navigate]);
    return null;
}
