import type { ReactNode } from "react";

import { CORE_VIEWS } from "../registry/core.ts";
import { HostView } from "./HostView.tsx";
import { OutputView } from "./OutputView.tsx";
import { SessionsView } from "./SessionsView.tsx";
import type { ViewProps } from "./env.tsx";

const CORE_RENDERERS: Readonly<Record<string, (props: ViewProps) => ReactNode>> = {
    [CORE_VIEWS.host]: (props) => <HostView {...props} />,
    [CORE_VIEWS.sessions]: (props) => <SessionsView {...props} />,
    [CORE_VIEWS.output]: (props) => <OutputView {...props} />,
};

// A registered view with no renderer in this client shows nothing.
export function renderView(viewId: string, props: ViewProps): ReactNode {
    return CORE_RENDERERS[viewId]?.(props) ?? null;
}
