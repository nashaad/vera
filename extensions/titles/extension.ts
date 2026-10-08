import type { VeraExtensionApi } from "../../src/sdk/extensions.ts";
import { cleanTitle, TITLE_PROMPT, titleMessages, wantsTitle } from "./titles.ts";

export function activate(vera: VeraExtensionApi): void {
    vera.hooks.registerTurnFinished(async (payload) => {
        if (!wantsTitle(payload)) return;
        const result = await vera.model.oneshot({
            assignment: "snappy",
            systemPrompt: TITLE_PROMPT,
            messages: titleMessages(payload),
        });
        const title = cleanTitle(result.text);
        if (title === undefined) return;
        await vera.sessions.setTitle(payload.sessionId, title);
    });
}
