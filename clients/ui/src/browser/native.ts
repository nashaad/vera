import type { BrowserBounds, BrowserHandoffAnswer, BrowserState } from "./native-types.ts";
import { browserSlots } from "./slots.ts";

type NativeValue = string | number | boolean | null | BrowserBounds | BrowserHandoffAnswer;

let sent = 0;
let applied = 0;

// Sends a command to the shell's browser and records the pages it answers with. An answer older than
// one already recorded is dropped, so a slow read never undoes a newer open or close.
export async function nativeCommand(name: string, value?: NativeValue): Promise<BrowserState | undefined> {
    sent += 1;
    const ticket = sent;
    try {
        const next = await window.veraDesktop?.browser(name, value);
        if (next !== undefined && ticket > applied) {
            applied = ticket;
            const { opened: _opened, ...pages } = next;
            browserSlots.read(pages);
        }
        return next;
    } catch {
        return undefined;
    }
}
