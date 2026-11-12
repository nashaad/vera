import { useCallback, useRef, useState } from "react";

import { ChevronDownIcon } from "../components/Icons.tsx";
import { usePopoverPlacement } from "../components/usePopoverPlacement.ts";
import { resolveModelArgument } from "../composer/slash/args.ts";
import { PILL_DONE, usePillRequests } from "../composer/slash/pillRequests.ts";
import { useMenuDismiss } from "../composer/useMenuDismiss.ts";
import { modelName, shortModelName } from "./catalog.ts";
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
    // A search typed after /model; the menu opens with it filled in.
    const [query, setQuery] = useState("");
    const root = useRef<HTMLDivElement>(null);
    const close = useCallback(() => setOpen(false), []);
    usePillRequests("model", (argument) => {
        if (!controls.enabled || controls.settings === undefined) return { done: false, message: "The model cannot be changed right now" };
        const resolved = argument.trim().length === 0 ? undefined : resolveModelArgument(controls.settings, argument);
        if (resolved?.kind === "pick") {
            controls.actions.pick(resolved.choice);
            return PILL_DONE;
        }
        setQuery(resolved?.query ?? "");
        setOpen(true);
        return PILL_DONE;
    });
    useMenuDismiss(open, root, close);
    const placed = usePopoverPlacement(open, root);

    const { settings, choice } = controls;
    const name = settings === undefined || choice === undefined ? "Model" : shortModelName(settings, choice);
    const fullName = settings === undefined || choice === undefined ? name : modelName(settings, choice);
    const provider = settings === undefined || choice?.provider === undefined ? undefined : providerLabel(settings, choice.provider);
    const title = provider === undefined ? "Choose a model" : `${fullName}, via ${provider}`;

    return (
        <div className="model-picker" ref={root}>
            <button
                type="button"
                className="pill-button model-pill"
                aria-haspopup="menu"
                aria-expanded={open}
                title={title}
                disabled={!controls.enabled}
                onClick={() => {
                    setQuery("");
                    setOpen(!open);
                }}
            >
                <span className="pill-label">{name}</span>
                {controls.note === undefined ? null : <span className="pill-sub">{controls.note}</span>}
                <ChevronDownIcon className="pill-chevron" />
            </button>
            {open && settings !== undefined ? (
                <ModelMenu controls={controls} settings={settings} onClose={close} onBrowse={onBrowse} style={placed} initialQuery={query} />
            ) : null}
        </div>
    );
}
