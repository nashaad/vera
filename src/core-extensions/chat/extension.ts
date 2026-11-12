import type { VeraExtensionApi } from "../../sdk/extensions.ts";

export function activate(vera: VeraExtensionApi): void {
    vera.agents.register({
        name: "chat",
        description: "Conversation with web lookups and files in the chat's own folder.",
        instructions: "",
        tools: ["web_search", "web_fetch", "read", "list", "write", "edit"],
    });
}
