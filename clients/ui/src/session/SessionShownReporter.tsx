import { useEffect } from "react";

import { useRouter } from "../pages/router.tsx";

// Tells the shell which session the page shows, so a relaunch into a newer build can reopen it.
// Drawing nothing keeps this out of the page's own renders.
export function SessionShownReporter(): null {
    const { route } = useRouter();
    const agentId = route.kind === "session" ? route.agentId : undefined;
    useEffect(() => {
        window.veraDesktop?.reportSessionShown(agentId);
    }, [agentId]);
    return null;
}
