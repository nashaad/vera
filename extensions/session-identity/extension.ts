import type { VeraExtensionApi } from "../../src/sdk/extensions.ts";
import { agentNameKey, mintAgentName } from "./names.ts";

export function activate(vera: VeraExtensionApi): void {
    vera.sessions.registerIdentity({
        mint({ taken }) {
            const name = mintAgentName(taken);
            return {
                name,
                key: agentNameKey(name)!,
            };
        },
        keyOf: agentNameKey,
    });
}
