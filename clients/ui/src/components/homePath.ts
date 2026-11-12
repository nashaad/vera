const USER_HOME = /^(?:\/Users|\/home)\/[^/]+|^[A-Za-z]:\\Users\\[^\\]+/;
const KEPT_SEGMENTS = 2;
const SHOWN_SEGMENTS = 3;

// A path short enough for one line: the user's home becomes "~" and a long
// middle becomes an ellipsis. The caller keeps the full path for a tooltip.
export function shortenPath(path: string): string {
    const separator = path.includes("\\") && !path.includes("/") ? "\\" : "/";
    const home = USER_HOME.exec(path);
    const prefix = home === null ? "" : "~";
    const parts = path.slice(home === null ? 0 : home[0].length).split(separator).filter((part) => part !== "");
    if (parts.length > SHOWN_SEGMENTS) {
        return `${prefix}${separator}…${separator}${parts.slice(-KEPT_SEGMENTS).join(separator)}`;
    }
    if (parts.length === 0) return prefix === "" ? path : prefix;
    const lead = prefix !== "" || path.startsWith(separator) ? separator : "";
    return `${prefix}${lead}${parts.join(separator)}`;
}
