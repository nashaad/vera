import type { VeraClientExtensionApi } from "../../sdk/extensions.ts";
import { PLUGIN_BROWSER_COMMAND } from "./commands.ts";
import { registerSourceBrowser } from "./view.ts";

export function activateClient(vera: VeraClientExtensionApi): void {
    const browser = registerSourceBrowser(vera);
    vera.commands.register({
        name: PLUGIN_BROWSER_COMMAND,
        description: "Browse definitions, skills, instructions, memory, and extensions",
        usage: "/plugins", interactive: true,
        async run({ argumentsText, signal }) {
            if (argumentsText.trim() !== "") return { kind: "text", text: "Usage: /plugins" };
            await browser.open(signal);
            return { kind: "handled" };
        },
    });
}
