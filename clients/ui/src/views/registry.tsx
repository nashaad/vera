import type { ReactNode } from "react";

import { GENERIC_PAGE_KIND, pagePathOfKind } from "../pagepane/kinds.ts";
import { CORE_VIEWS } from "../registry/core.ts";
import { BrowserView } from "./BrowserView.tsx";
import { ChatView } from "./ChatView.tsx";
import { FilesView } from "./FilesView.tsx";
import { OutputView } from "./OutputView.tsx";
import { GenericPageView, PageView } from "./PageView.tsx";
import { PlanView } from "./PlanView.tsx";
import { ReviewView } from "./ReviewView.tsx";
import { SessionsFilterButton } from "./SessionsFilterButton.tsx";
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

const CORE_HEADER_ACTIONS: Readonly<Record<string, () => ReactNode>> = {
    [CORE_VIEWS.sessions]: () => <SessionsFilterButton />,
};

export function renderViewHeaderAction(viewId: string): ReactNode {
    return CORE_HEADER_ACTIONS[viewId]?.() ?? null;
}

// A registered view with no renderer in this client shows nothing. A view an extension page's pane
// registered is drawn as that page.
export function renderView(viewId: string, props: ViewProps): ReactNode {
    if (viewId === GENERIC_PAGE_KIND) return <GenericPageView />;
    const page = pagePathOfKind(viewId);
    if (page !== undefined) return <PageView {...props} path={page} />;
    return CORE_RENDERERS[viewId]?.(props) ?? null;
}
