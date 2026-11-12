import { useCallback, useRef, useState } from "react";

import { ChevronDownIcon } from "../components/Icons.tsx";
import { usePopoverPlacement } from "../components/usePopoverPlacement.ts";
import { useMenuDismiss } from "../composer/useMenuDismiss.ts";
import { modelName } from "./catalog.ts";
import type { ModelControls } from "./controls.ts";
import { ModelMenu } from "./ModelMenu.tsx";
import { providerLabel } from "./menuRows.ts";

export interface ModelPillProps {
    readonly controls: ModelControls;
    readonly onBrowse: () => void;
}

// The model the session runs, or New Chat will start with, and the menu that changes it.
export function ModelPill({ controls, onBrowse }: ModelPillProps) {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const close = useCallback(() => setOpen(false), []);
    useMenuDismiss(open, root, close);
    const placed = usePopoverPlacement(open, root);

    const { settings, choice } = controls;
    const name = settings === undefined || choice === undefined ? "Model" : modelName(settings, choice);
    const provider = settings === undefined || choice?.provider === undefined ? undefined : providerLabel(settings, choice.provider);
    const title = provider === undefined ? "Choose a model" : `${name}, via ${provider}`;

    return (
        <div className="model-picker" ref={root}>
            <button
                type="button"
                className="pill-button model-pill"
                aria-haspopup="menu"
                aria-expanded={open}
                title={title}
                disabled={!controls.enabled}
                onClick={() => setOpen(!open)}
            >
                {provider === undefined ? null : <span className="pill-sub model-provider">{provider}</span>}
                <span className="pill-label">{name}</span>
                {controls.note === undefined ? null : <span className="pill-sub">{controls.note}</span>}
                <ChevronDownIcon className="pill-chevron" />
            </button>
            {open && settings !== undefined ? (
                <ModelMenu controls={controls} settings={settings} onClose={close} onBrowse={onBrowse} style={placed} />
            ) : null}
        </div>
    );
}
