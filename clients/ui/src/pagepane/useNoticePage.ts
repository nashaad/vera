import { useCallback, useRef } from "react";

import type { NoticeLink } from "../session/model.ts";
import { useWorkbench } from "../workbench/context.tsx";
import { usePageLinks } from "./PageLinks.tsx";
import { noticePage, noticeTarget } from "./notices.ts";

// What to call for each new link notice of the shown session. Reads the window as it is at the call.
export function useNoticePage(): (link: NoticeLink) => void {
    const workbench = useWorkbench();
    const { annex } = usePageLinks();
    const latest = useRef({ workbench, annex });
    latest.current = { workbench, annex };
    return useCallback((link) => {
        const target = noticeTarget(link, latest.current.annex);
        if (target !== undefined) noticePage(latest.current.workbench, target);
    }, []);
}
