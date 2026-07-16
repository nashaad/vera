import {
    TextareaRenderable,
    type RenderContext,
} from "@opentui/core";

export function createTuiComposer(
    renderer: RenderContext,
    onSubmit: () => void,
): TextareaRenderable {
    return new TextareaRenderable(renderer, {
        id: "composer",
        width: "100%",
        height: 3,
        placeholder: "Message Vera…",
        backgroundColor: "#16161E",
        focusedBackgroundColor: "#16161E",
        textColor: "#F0F0F0",
        focusedTextColor: "#FFFFFF",
        cursorColor: "#7AA2F7",
        keyBindings: [
            { name: "return", action: "submit" },
            { name: "kpenter", action: "submit" },
            { name: "return", shift: true, action: "newline" },
            { name: "kpenter", shift: true, action: "newline" },
        ],
        onSubmit,
    });
}
