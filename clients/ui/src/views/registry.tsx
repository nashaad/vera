import type { ReactNode } from "react";

import { CORE_VIEWS } from "../registry/core.ts";
import { HostView } from "./HostView.tsx";
import { FilesView } from "./FilesView.tsx";
import { OutputView } from "./OutputView.tsx";
import { PlanView } from "./PlanView.tsx";
import { PreviewView } from "./PreviewView.tsx";
import { ReviewView } from "./ReviewView.tsx";
import { SessionsView } from "./SessionsView.tsx";
import type { ViewProps } from "./env.tsx";

const CORE_RENDERERS: Readonly<Record<string, (props: ViewProps) => ReactNode>> = {
    [CORE_VIEWS.host]: (props) => <HostView {...props} />,
    [CORE_VIEWS.sessions]: (props) => <SessionsView {...props} />,
    [CORE_VIEWS.output]: (props) => <OutputView {...props} />,
    [CORE_VIEWS.review]: (props) => <ReviewView {...props} />,
    [CORE_VIEWS.plan]: (props) => <PlanView {...props} />,
    [CORE_VIEWS.files]: (props) => <FilesView {...props} />,
    [CORE_VIEWS.preview]: (props) => <PreviewView {...props} />,
};

// A registered view with no renderer in this client shows nothing.
export function renderView(viewId: string, props: ViewProps): ReactNode {
    return CORE_RENDERERS[viewId]?.(props) ?? null;
}
