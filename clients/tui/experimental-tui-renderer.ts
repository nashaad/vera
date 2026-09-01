import {
    BoxRenderable,
    TextAttributes,
    TextRenderable,
    type CliRenderer,
    type MouseEvent,
    type Renderable,
} from "@opentui/core";

import type { TuiTheme } from "./theme.ts";
import type {
    VeraExperimentalTuiNode,
    VeraExperimentalTuiTone,
} from "../../src/sdk/experimental-tui.ts";

const MAX_NODE_DEPTH = 20;
const MAX_NODE_CHILDREN = 100;
const MAX_TEXT_LENGTH = 8_000;

export interface TuiExperimentalViewRenderOptions {
    readonly renderer: CliRenderer;
    readonly theme: TuiTheme;
    readonly node: VeraExperimentalTuiNode;
    readonly id: string;
    readonly overlay: boolean;
    readonly title?: string;
    readonly notice?: string;
    readonly focus: () => void;
    readonly triggerAction: (action: string) => void | Promise<void>;
}

export function renderTuiExperimentalView(
    options: TuiExperimentalViewRenderOptions,
): BoxRenderable {
    const root = new BoxRenderable(options.renderer, {
        id: options.id,
        width: "100%",
        flexDirection: "column",
        paddingLeft: 1,
        paddingRight: 1,
        ...(options.overlay ? { flexGrow: 1 } : {}),
    });
    if (options.title !== undefined) {
        root.add(new TextRenderable(options.renderer, {
            id: `${root.id}-title`,
            selectable: true,
            content: options.notice === undefined
                ? options.title
                : `${options.title} · ${options.notice}`,
            fg: options.theme.accent,
            attributes: TextAttributes.BOLD,
            width: "100%",
            height: 1,
        }));
    }
    root.add(renderNode(options, options.node, `${root.id}-content`));
    return root;
}

export function validateTuiExperimentalNode(
    node: VeraExperimentalTuiNode,
    depth = 0,
): void {
    if (depth > MAX_NODE_DEPTH || typeof node !== "object" || node === null) {
        throw new Error("Experimental TUI view returned an invalid node tree");
    }
    if (node.kind === "text") {
        if (typeof node.text !== "string" || node.text.length > MAX_TEXT_LENGTH) {
            throw new Error("Experimental TUI text is invalid or too long");
        }
        return;
    }
    if (node.kind === "rule") return;
    if (node.kind === "button") {
        if (
            typeof node.label !== "string"
            || node.label.length === 0
            || node.label.length > 240
            || typeof node.action !== "string"
            || node.action.length === 0
        ) {
            throw new Error("Experimental TUI button is invalid");
        }
        return;
    }
    if (
        node.kind !== "stack"
        || !Array.isArray(node.children)
        || node.children.length > MAX_NODE_CHILDREN
        || (node.gap !== undefined
            && (!Number.isInteger(node.gap) || node.gap < 0 || node.gap > 8))
    ) {
        throw new Error("Experimental TUI stack is invalid");
    }
    for (const child of node.children) {
        validateTuiExperimentalNode(child, depth + 1);
    }
}

interface NodeRenderOptions extends TuiExperimentalViewRenderOptions {}

function renderNode(
    options: NodeRenderOptions,
    node: VeraExperimentalTuiNode,
    id: string,
): Renderable {
    if (node.kind === "text") {
        return new TextRenderable(options.renderer, {
            id,
            content: node.text,
            fg: toneColor(options.theme, node.tone),
            attributes: node.bold ? TextAttributes.BOLD : undefined,
            width: "100%",
            wrapMode: "word",
            selectable: true,
        });
    }
    if (node.kind === "rule") {
        return new TextRenderable(options.renderer, {
            id,
            content: "─".repeat(Math.max(1, Math.min(240, options.renderer.terminalWidth - 4))),
            selectable: false,
            fg: toneColor(options.theme, node.tone ?? "muted"),
            width: "100%",
            height: 1,
        });
    }
    if (node.kind === "button") {
        const button = new BoxRenderable(options.renderer, {
            id,
            width: "100%",
            height: 1,
            paddingLeft: 1,
            paddingRight: 1,
            backgroundColor: node.selected
                ? options.theme.accent
                : options.theme.panel,
            visible: !node.disabled,
            onMouseDown: (event: MouseEvent) => {
                event.preventDefault();
                event.stopPropagation();
                options.focus();
                void options.triggerAction(node.action);
            },
        });
        button.add(new TextRenderable(options.renderer, {
            id: `${id}-label`,
            content: node.label,
            fg: toneColor(options.theme, node.tone ?? "text"),
            width: "100%",
            height: 1,
        }));
        return button;
    }
    const stack = new BoxRenderable(options.renderer, {
        id,
        width: "100%",
        flexDirection: node.direction,
        gap: node.gap ?? 0,
    });
    node.children.forEach((child, index) => {
        stack.add(renderNode(options, child, `${id}-${index}`));
    });
    return stack;
}

function toneColor(theme: TuiTheme, tone: VeraExperimentalTuiTone | undefined): string {
    switch (tone) {
        case "muted": return theme.muted;
        case "accent": return theme.accent;
        case "notice": return theme.notice;
        case "success": return theme.success;
        default: return theme.text;
    }
}
