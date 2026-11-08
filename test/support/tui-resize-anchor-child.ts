import { startTui, type TuiDependencies } from "../../clients/tui/main.ts";
import { createSettingsAnsweringClient } from "./settings-answering-client.ts";
import { installTestProcessGuard } from "./self-terminate-guard.ts";

const PHRASES = [
    "salt wind over the rigging and a loose halyard",
    "ledger entries for the harbour master, none of them honest",
    "a lantern swings; the tide table says half past never",
    "barnacles on the keel, rumours in the crow's nest",
];

export function resizeAnchorReply(): string {
    return Array.from({ length: 300 }, (_, index) => {
        const number = index + 1;
        const tag = `LINE${String(number).padStart(3, "0")}`;
        const phrase = PHRASES[number % PHRASES.length]!;
        if (number === 1) return `${tag} FIRST-LINE-OF-THE-LONG-REPLY ${phrase}`;
        if (number === 300) return `${tag} LAST-LINE-OF-THE-LONG-REPLY END-OF-LONG-REPLY`;
        return number % 5 === 0
            ? `${tag} ${phrase} ${phrase} and again ${phrase} wrap-marker-${number}`
            : `${tag} ${phrase}`;
    }).join("\n");
}

export function createResizeAnchorDependencies(): TuiDependencies {
    return {
        client: createSettingsAnsweringClient({
            agentId: "resize-anchor-session",
            workspace: "/work/vera",
            model: "resize-anchor-model",
            mode: "auto",
            initialUpdates: [{
                type: "history",
                entries: [
                    { kind: "user", text: "tell me a long story" },
                    { kind: "assistant", text: resizeAnchorReply() },
                ],
                seq: 0,
            }],
        }),
        listAgents: async () => [],
    };
}

if (import.meta.main) {
    installTestProcessGuard();
    await startTui(createResizeAnchorDependencies());
}
