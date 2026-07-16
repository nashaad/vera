export interface PromptKeydown {
    readonly key: string;
    readonly shiftKey: boolean;
    readonly isComposing: boolean;
}

export interface PromptFocusTarget {
    readonly disabled: boolean;
    focus(): void;
}

export function shouldSendPromptOnKeydown(event: PromptKeydown): boolean {
    return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}

export function focusPromptIfReady(prompt: PromptFocusTarget): boolean {
    if (prompt.disabled) {
        return false;
    }
    prompt.focus();
    return true;
}
