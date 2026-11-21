// Eval limits, the eval tool's description and its error lines. The extension and the desktop pane both use them.

export const EVAL_SCRIPT_LIMIT = 20_000;
export const EVAL_TIMEOUT_DEFAULT_MS = 10_000;
export const EVAL_TIMEOUT_LIMIT_MS = 20_000;
export const EVAL_RESULT_LIMIT = 30_000;
const EVAL_MESSAGE_LIMIT = 500;

export const EVAL_DESCRIPTION = "Run JavaScript in the page open in the Browser pane of the Vera desktop window, to pull out data that builtin_browser read does not give, such as every link, table rows or values in the page. The script is the body of an async function and must return a JSON value. It runs in an isolated world: it sees the page's DOM but not the page's own JavaScript variables. The result is cut at 30,000 characters. Open the page with builtin_browser first.";

export const EVAL_NOT_JSON = "The script returned a value that is not JSON.";

export function evalThrew(message: string): string {
    const text = message.replace(/\s+/g, " ").trim().slice(0, EVAL_MESSAGE_LIMIT);
    return `The script threw: ${text}`;
}

export function evalTimedOut(milliseconds: number): string {
    return `The script did not finish within ${milliseconds / 1000} seconds.`;
}

export function evalCut(total: number): string {
    return `Showing the first ${EVAL_RESULT_LIMIT.toLocaleString("en-US")} characters of ${total.toLocaleString("en-US")}.`;
}
