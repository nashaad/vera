import { usePageTabPath } from "../pagepane/store.ts";
import { usePaneTab } from "../workbench/tab-context.tsx";
import type { ViewProps } from "./env.tsx";
import { PageFrame } from "./PageFrame.tsx";

interface PageViewProps extends ViewProps {
    // The annex path of the page this pane is for; a tab shows it bare until something opens it on a query.
    readonly path: string;
}

// One tab of an extension page's own pane: the Browser's frame, held to that one page.
export function PageView({ path }: PageViewProps) {
    const shown = usePageTabPath(usePaneTab());
    return <PageFrame path={path} {...(shown === undefined ? {} : { shown })} />;
}
