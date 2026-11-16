import type { ReactNode } from "react";

import { CORE_VIEWS } from "../registry/core.ts";
import { BrowserView } from "./BrowserView.tsx";
import { ChatView } from "./ChatView.tsx";
import { FilesView } from "./FilesView.tsx";
import { OutputView } from "./OutputView.tsx";
import { PlanView } from "./PlanView.tsx";
import { ReviewView } from "./ReviewView.tsx";
import { SessionsView } from "./SessionsView.tsx";
import { SubagentsView } from "./SubagentsView.tsx";
import type { ViewProps } from "./env.tsx";

const CORE_RENDERERS: Readonly<Record<string, (props: ViewProps) => ReactNode>> = {
    [CORE_VIEWS.sessions]: (props) => <SessionsView {...props} />,
    [CORE_VIEWS.output]: (props) => <OutputView {...props} />,
    [CORE_VIEWS.review]: (props) => <ReviewView {...props} />,
    [CORE_VIEWS.plan]: (props) => <PlanView {...props} />,
    [CORE_VIEWS.files]: (props) => <FilesView {...props} />,
    [CORE_VIEWS.browser]: (props) => <BrowserView {...props} />,
    [CORE_VIEWS.chat]: (props) => <ChatView {...props} />,
    [CORE_VIEWS.subagents]: (props) => <SubagentsView {...props} />,
};

// A registered view with no renderer in this client shows nothing.
export function renderView(viewId: string, props: ViewProps): ReactNode {
    return CORE_RENDERERS[viewId]?.(props) ?? null;
}
