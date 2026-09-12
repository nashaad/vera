import {
    BoxRenderable,
    type CliRenderer,
    type Renderable,
} from "@opentui/core";

import type {
    VeraExperimentalTuiContext,
    VeraExperimentalTuiRawViewSpec,
    VeraExperimentalTuiTheme,
} from "../../src/sdk/experimental-tui.ts";

import { dialogHeaderNode } from "./dialog-header.ts";

export interface TuiExperimentalRawView {
    readonly extensionId: string;
    readonly spec: VeraExperimentalTuiRawViewSpec;
    readonly root: Renderable;
    readonly container: BoxRenderable;
}

export interface TuiExperimentalRawViewCreateOptions {
    readonly renderer: CliRenderer;
    readonly extensionId: string;
    readonly spec: VeraExperimentalTuiRawViewSpec;
    readonly workspace: string;
    readonly theme: VeraExperimentalTuiTheme;
    readonly transcript: VeraExperimentalTuiContext["transcript"];
    readonly requestRender: () => void;
}

export function createTuiExperimentalRawView(
    options: TuiExperimentalRawViewCreateOptions,
): TuiExperimentalRawView {
    const root = options.spec.create({
        renderer: options.renderer,
        workspace: options.workspace,
        theme: options.theme,
        transcript: options.transcript,
        requestRender: options.requestRender,
    });
    if (
        typeof root !== "object"
        || root === null
        || typeof root.destroy !== "function"
    ) {
        throw new Error("Raw experimental TUI view must return a Renderable");
    }
    const container = new BoxRenderable(options.renderer, {
        id: `experimental-tui-raw-${options.extensionId}-${options.spec.id}`,
        width: "100%",
        flexDirection: "column",
    });
    if (options.spec.slot === "overlay") {
        container.add(dialogHeaderNode(options.renderer, "Extension"));
    }
    container.add(root);
    return {
        extensionId: options.extensionId,
        spec: options.spec,
        root,
        container,
    };
}

export function disposeTuiExperimentalRawView(
    view: TuiExperimentalRawView,
    removeFromSlot: (containerId: string) => void,
): void {
    let firstFailure: unknown;
    try {
        removeFromSlot(view.container.id);
    } catch (error) {
        firstFailure = error;
    }
    try {
        view.root.destroyRecursively();
    } catch (error) {
        firstFailure ??= error;
    }
    try {
        view.container.destroyRecursively();
    } catch (error) {
        firstFailure ??= error;
    }
    if (firstFailure !== undefined) throw firstFailure;
}

export function refreshTuiExperimentalRawView(
    view: TuiExperimentalRawView,
    onFailure: (extensionId: string, message: string) => void,
): void {
    try {
        view.container.visible = view.spec.visible?.() ?? true;
    } catch (error) {
        onFailure(
            view.extensionId,
            error instanceof Error ? error.message : String(error),
        );
        view.container.visible = false;
    }
}
