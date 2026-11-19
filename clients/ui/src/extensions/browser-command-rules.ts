import type { DesktopMenuItem } from "../protocol/extensions.ts";

export function browserCommandAvailable(item: DesktopMenuItem, hasSession: boolean, frameName: string | undefined): boolean {
    return hasSession || (frameName === undefined && item.page === true);
}
