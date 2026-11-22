import { useEffect, useRef, useState } from "react";

import { PILL_DONE, usePillRequests } from "../composer/slash/pillRequests.ts";
import type { ModelControls } from "./controls.ts";
import { EffortPill } from "./EffortPill.tsx";
import { ModelPill } from "./ModelPill.tsx";
import { ModelsBrowser } from "./browser/ModelsBrowser.tsx";
import { OPEN_MODEL_DEFAULTS_EVENT, type OpenModelDefaultsDetail } from "./open-defaults.ts";
import type { BrowserTab } from "./browser/rows.ts";

export interface ModelPillsProps {
    readonly controls: ModelControls;
}

// The model and effort pills at the end of the composer bar.
export function ModelPills({ controls }: ModelPillsProps) {
    const root = useRef<HTMLSpanElement>(null);
    const [browsing, setBrowsing] = useState(false);
    const [initialTab, setInitialTab] = useState<BrowserTab>("All models");
    const [onSubagentsChanged, setOnSubagentsChanged] = useState<(() => void) | undefined>();
    useEffect(() => {
        const openDefaults = (event: Event): void => {
            const detail = (event as CustomEvent<OpenModelDefaultsDetail>).detail;
            if (typeof detail?.onSubagentsChanged !== "function") return;
            setOnSubagentsChanged(() => detail.onSubagentsChanged);
            setInitialTab("Defaults");
            setBrowsing(true);
        };
        const session = root.current?.closest(".session-page");
        session?.addEventListener(OPEN_MODEL_DEFAULTS_EVENT, openDefaults);
        return () => session?.removeEventListener(OPEN_MODEL_DEFAULTS_EVENT, openDefaults);
    }, []);
    usePillRequests("models", () => {
        if (controls.settings === undefined) return { done: false, message: "The models have not loaded yet" };
        setOnSubagentsChanged(undefined);
        setInitialTab("All models");
        setBrowsing(true);
        return PILL_DONE;
    });
    return (
        <span ref={root} className="model-pills" data-enabled={controls.enabled}>
            <ModelPill controls={controls} onBrowse={() => { setOnSubagentsChanged(undefined); setInitialTab("All models"); setBrowsing(true); }} />
            <EffortPill controls={controls} />
            {browsing ? <ModelsBrowser controls={controls} initialTab={initialTab} onSubagentsChanged={onSubagentsChanged} onClose={() => { setBrowsing(false); setOnSubagentsChanged(undefined); }} /> : null}
        </span>
    );
}
