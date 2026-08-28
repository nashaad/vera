import type { VeraExtensionApi } from "../../src/sdk/extensions.ts";
import { agentNameKey, mintAgentName } from "./names.ts";

// Bundled by Vera, but limited to the same public host API as user extensions.
export function activate(vera: VeraExtensionApi): void {
    vera.sessions.registerIdentity({
        mint({ taken }) {
            const name = mintAgentName(taken);
            return {
                name,
                key: agentNameKey(name)!,
                env: {
                    ARC_SESSION: name,
                    COORD_SESSION: name,
                },
                context: {
                    text: `Your session identity is ${name}.`,
                },
            };
        },
        keyOf: agentNameKey,
    });
}
