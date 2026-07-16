import { expect, test } from "bun:test";

import {
    focusPromptIfReady,
    shouldSendPromptOnKeydown,
} from "../../clients/desktop/src/composer.ts";

test("desktop composer sends with Enter and keeps Shift+Enter for newlines", () => {
    expect(shouldSendPromptOnKeydown(keydown("Enter"))).toBe(true);
    expect(shouldSendPromptOnKeydown(keydown("Enter", { shiftKey: true }))).toBe(false);
    expect(shouldSendPromptOnKeydown(keydown("a"))).toBe(false);
});

test("desktop composer does not submit while an input method is composing", () => {
    expect(shouldSendPromptOnKeydown(keydown("Enter", { isComposing: true }))).toBe(false);
});

test("desktop composer focuses only after rendering makes it ready", () => {
    let focusCount = 0;
    const prompt = {
        disabled: true,
        focus() {
            focusCount += 1;
        },
    };

    expect(focusPromptIfReady(prompt)).toBe(false);
    expect(focusCount).toBe(0);

    prompt.disabled = false;
    expect(focusPromptIfReady(prompt)).toBe(true);
    expect(focusCount).toBe(1);
});

function keydown(
    key: string,
    options: { readonly shiftKey?: boolean; readonly isComposing?: boolean } = {},
) {
    return {
        key,
        shiftKey: options.shiftKey ?? false,
        isComposing: options.isComposing ?? false,
    };
}
