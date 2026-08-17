import {
    BoxRenderable,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import {
    TUI_MUTED,
    TUI_NOTICE,
    TUI_PANEL,
    TUI_TEXT,
} from "./state.ts";
import { centeredDialogSurface } from "./dialog-chrome.ts";
import type { ProviderDescriptor } from "../../src/providers/registry.ts";

export type TuiProviderForgetConfirmResult = "confirm" | "cancel" | undefined;

/**
 * What `delete` on a connected row should do: ask, or say why it cannot.
 *
 * A row is marked connected whenever the provider can run, which includes one
 * reading an environment variable Vera never stored. Confirming a deletion of
 * nothing would leave the row still marked and the key still in use, so only a
 * credential Vera holds reaches the confirmation.
 */
export type TuiProviderForgetDecision =
    | { readonly kind: "confirm" }
    | { readonly kind: "explain"; readonly message: string };

export function tuiProviderForgetDecision(
    provider: Pick<ProviderDescriptor, "label" | "credential" | "envVar">,
    stored: boolean,
    envValue: string | undefined,
): TuiProviderForgetDecision {
    if (provider.credential === "none") {
        return {
            kind: "explain",
            message:
                `${provider.label} needs no credentials, so there is nothing to forget`,
        };
    }
    if (stored) {
        return { kind: "confirm" };
    }
    return {
        kind: "explain",
        message: provider.envVar !== undefined
                && envValue !== undefined
                && envValue !== ""
            ? `${provider.label} is connected through ${provider.envVar}, which Vera did not store: unset it in your shell to disconnect`
            : `${provider.label} has no stored credential to forget`,
    };
}

export interface TuiProviderForgetConfirmView {
    readonly box: BoxRenderable;
    readonly surface: BoxRenderable;
    update(label: string): void;
}

export function handleTuiProviderForgetConfirmKey(
    key: {
        readonly name: string;
        readonly ctrl?: boolean;
        readonly meta?: boolean;
        readonly shift?: boolean;
        readonly super?: boolean;
        readonly hyper?: boolean;
    },
): TuiProviderForgetConfirmResult {
    if (
        key.name === "1"
        && !key.ctrl
        && !key.meta
        && !key.shift
        && !key.super
        && !key.hyper
    ) {
        return "confirm";
    }
    if (key.name === "escape") {
        return "cancel";
    }
    return undefined;
}

export function createTuiProviderForgetConfirmView(
    renderer: RenderContext,
): TuiProviderForgetConfirmView {
    const title = new TextRenderable(renderer, {
        content: "Forget this stored credential?",
        fg: TUI_NOTICE,
        width: "100%",
        height: 1,
    });
    const name = new TextRenderable(renderer, {
        content: "",
        fg: TUI_TEXT,
        width: "100%",
        height: "auto",
        wrapMode: "word",
        marginTop: 1,
    });
    const detail = new TextRenderable(renderer, {
        content: "Vera deletes the secret it stored. Nothing recovers it: connecting again asks for a new one.",
        fg: TUI_MUTED,
        width: "100%",
        height: "auto",
        wrapMode: "word",
        marginTop: 1,
    });
    const footer = new TextRenderable(renderer, {
        content: "[1] forget · [esc] cancel",
        fg: TUI_NOTICE,
        width: "100%",
        height: 1,
        marginTop: 1,
    });
    const box = new BoxRenderable(renderer, {
        id: "provider-forget-confirm",
        border: false,
        backgroundColor: TUI_PANEL,
        width: "70%",
        height: "auto",
        flexDirection: "column",
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        paddingBottom: 1,
        focusable: true,
    });
    box.add(title);
    box.add(name);
    box.add(detail);
    box.add(footer);
    const surface = centeredDialogSurface(
        renderer,
        "provider-forget-confirm-surface",
        box,
    );
    return {
        box,
        surface,
        update(label): void {
            name.content = label;
        },
    };
}
