import { SESSIONS_PAGE_SIZE } from "../../protocol/sessions.ts";

// The desktop keeps its own files under machine/desktop in the home. The separator follows the home's own style.
export function desktopFolder(home: string | undefined): string | undefined {
    if (home === undefined || home.length === 0) return undefined;
    const separator = home.includes("\\") && !home.includes("/") ? "\\" : "/";
    const base = home.replace(/[\\/]+$/, "");
    return `${base}${separator}machine${separator}desktop`;
}

// The host lists one page of sessions, so a full page means there may be more.
export function sessionCountLabel(count: number | undefined, attached: boolean, pageSize: number = SESSIONS_PAGE_SIZE): string {
    if (!attached) return "Not connected";
    if (count === undefined) return "Loading";
    if (count >= pageSize) return `${pageSize}+`;
    return String(count);
}
