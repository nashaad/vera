import { useRef, useState, useSyncExternalStore } from "react";

import { PointerIcon } from "../components/PointerIcon.tsx";
import { queuePageCapture, type PageCapture } from "../composer/page-captures.ts";
import { addOwnerCapture, closeOwnerCommand, startDraftCaptureOwner } from "../composer/draft-capture-owner.ts";
import { useRouter } from "../pages/router.tsx";
import type { DesktopMenuItem } from "../protocol/extensions.ts";
import { useActiveSession } from "../session/activeSession.ts";
import { desktopExtensions, subscribeDesktopExtensions } from "./state.ts";
import { browserCommandAvailable } from "./browser-command-rules.ts";

interface BrowserCommandsProps {
    readonly hasPage: boolean;
    readonly onError: (reason: string | undefined) => void;
    readonly frameName?: string;
}

export function BrowserCommands({ hasPage, onError, frameName }: BrowserCommandsProps) {
    const extensions = useSyncExternalStore(subscribeDesktopExtensions, desktopExtensions);
    const session = useActiveSession();
    const router = useRouter();
    const latestRouter = useRef(router);
    latestRouter.current = router;
    const [running, setRunning] = useState(false);
    const run = async (item: DesktopMenuItem): Promise<void> => {
        if (window.veraDesktop === undefined) return;
        if (router.route.kind === "session" && session?.agentId !== router.route.agentId) return;
        const owner = router.route.kind === "session" ? session?.agentId : undefined;
        if (!browserCommandAvailable(item, owner !== undefined, frameName)) return;
        const draft = owner === undefined ? startDraftCaptureOwner(router.route.kind === "home" ? router.route.folder : undefined) : undefined;
        const deliver = (capture: PageCapture): void => {
            if (owner !== undefined) queuePageCapture(owner, capture);
            else if (draft !== undefined && addOwnerCapture(draft, capture) && draft.recipient.isDraft()) {
                const current = latestRouter.current;
                if (current.route.kind !== "home" || current.route.folder !== draft.folder) {
                    current.navigate({ kind: "home", ...(draft.folder === undefined ? {} : { folder: draft.folder }) });
                }
            }
        };
        setRunning(true);
        onError(undefined);
        try {
            const result = await window.veraDesktop.runExtensionCommand(item.command, undefined, (progress) => {
                if (!progress.ok) onError(progress.reason);
                else if (progress.kind === "capture") {
                    onError(undefined);
                    deliver(progress.capture);
                }
            }, frameName);
            if (!result.ok) onError(result.reason);
            else if (result.kind === "capture") deliver(result.capture);
        } catch { onError("The page could not be read."); }
        finally {
            if (draft !== undefined) closeOwnerCommand(draft);
            setRunning(false);
        }
    };
    return extensions?.filter((entry) => entry.enabled).flatMap((entry) => entry.menus.browser ?? []).map((item) => (
        <button key={item.command} type="button" className="icon-button" aria-label={item.title} title={item.title} aria-pressed={running} disabled={!hasPage || running || (router.route.kind === "session" && session?.agentId !== router.route.agentId) || !browserCommandAvailable(item, router.route.kind === "session" && session?.agentId === router.route.agentId, frameName)} onClick={() => void run(item)}>
            {item.icon === "pointer" ? <PointerIcon /> : null}
        </button>
    ));
}
