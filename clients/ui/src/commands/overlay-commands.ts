import { openOverlay } from "../overlays/store.ts";
import { OVERLAY_COMMANDS, type Overlay } from "./overlay-ids.ts";
import type { CommandRegistry } from "./registry.ts";

export { OVERLAY_COMMANDS };

export function registerOverlayCommands(registry: CommandRegistry): () => void {
    const disposers = (Object.keys(OVERLAY_COMMANDS) as Overlay[]).map((overlay) => registry.register({
        ...OVERLAY_COMMANDS[overlay],
        run: () => openOverlay(overlay),
    }));
    return () => {
        for (const dispose of disposers) dispose();
    };
}
