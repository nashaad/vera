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
    removeFromSlot(view.container.id);
    view.container.destroy();
}
