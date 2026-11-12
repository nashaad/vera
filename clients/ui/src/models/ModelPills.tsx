import { useState } from "react";

import { PILL_DONE, usePillRequests } from "../composer/slash/pillRequests.ts";
import type { ModelControls } from "./controls.ts";
import { EffortPill } from "./EffortPill.tsx";
import { ModelPill } from "./ModelPill.tsx";
import { ModelsBrowser } from "./browser/ModelsBrowser.tsx";

export interface ModelPillsProps {
    readonly controls: ModelControls;
}

// The model and effort pills at the end of the composer bar.
export function ModelPills({ controls }: ModelPillsProps) {
    const [browsing, setBrowsing] = useState(false);
    usePillRequests("models", () => {
        if (controls.settings === undefined) return { done: false, message: "The models have not loaded yet" };
        setBrowsing(true);
        return PILL_DONE;
    });
    return (
        <span className="model-pills" data-enabled={controls.enabled}>
            <ModelPill controls={controls} onBrowse={() => setBrowsing(true)} />
            <EffortPill controls={controls} />
            {browsing ? <ModelsBrowser controls={controls} onClose={() => setBrowsing(false)} /> : null}
        </span>
    );
}
