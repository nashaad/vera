import { ipcMain, type WebContents } from "electron";

import { parseUpdateAction, type UpdateState } from "../../ui/src/protocol/updates.ts";
import { CHANNELS } from "./channels.ts";
import type { UpdateService } from "./updates.ts";

interface Wiring {
    readonly service: UpdateService;
    readonly fromWindow: (event: { readonly sender: WebContents }) => boolean;
}

// Only the window answers or acts; the service decides what an action means in the current state.
export function registerUpdateHandlers({ service, fromWindow }: Wiring): void {
    ipcMain.handle(CHANNELS.updateState, (event): UpdateState | undefined => (fromWindow(event) ? service.current() : undefined));
    ipcMain.on(CHANNELS.update, (event, payload: unknown) => {
        const action = fromWindow(event) ? parseUpdateAction(payload) : undefined;
        if (action === undefined) return;
        switch (action.kind) {
            case "check":
                void service.check(true);
                break;
            case "run":
                void service.update();
                break;
            case "cancel":
                service.cancel();
                break;
            case "dismiss":
                service.dismiss();
                break;
            case "mode":
                void service.setMode(action.mode);
                break;
        }
    });
}
