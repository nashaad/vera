import type { VeraClientExtensionApi } from "../../sdk/extensions.ts";
import { registerSourceBrowser } from "./view.ts";

export function activateClient(vera: VeraClientExtensionApi): void {
    const browser = registerSourceBrowser(vera);
    vera.commands.register({
        name: "customize", description: "Browse definitions, skills, instructions, memory, and extensions",
        usage: "/customize", interactive: true,
        async run({ argumentsText, signal }) {
            if (argumentsText.trim() !== "") return { kind: "text", text: "Usage: /customize" };
            await browser.open(signal);
            return { kind: "handled" };
        },
    });
}
