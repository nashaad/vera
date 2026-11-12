import type { ReactElement } from "react";

import { DiffIcon, EyeIcon, FileIcon, ListIcon, type IconProps } from "../components/Icons.tsx";
import { CORE_CONTAINERS } from "../registry/core.ts";
import { useWorkbench } from "../workbench/context.tsx";
import { revealContainer } from "../workbench/reveal.ts";

const TOOLS: ReadonlyArray<readonly [string, string, (props: IconProps) => ReactElement]> = [
    [CORE_CONTAINERS.review, "Review", DiffIcon],
    [CORE_CONTAINERS.plan, "Plan", ListIcon],
    [CORE_CONTAINERS.files, "Files", FileIcon],
    [CORE_CONTAINERS.preview, "Preview", EyeIcon],
];

// Shortcuts into the right pane while it is closed.
export function SessionRail() {
    const workbench = useWorkbench();
    const placed = new Set(workbench.layout.locations.rightPane.all.map((container) => container.id));
    const tools = TOOLS.filter(([id]) => placed.has(id));
    if (tools.length === 0) return null;
    return (
        <nav className="session-rail" aria-label="Session tools">
            {tools.map(([id, title, Draw]) => (
                <button
                    key={id}
                    type="button"
                    className="header-button"
                    aria-label={title}
                    title={title}
                    data-rail={id}
                    onClick={() => revealContainer(workbench, id)}
                >
                    <Draw />
                </button>
            ))}
        </nav>
    );
}
