import { canOpenBrowser, OPEN_BROWSER_COMMAND } from "../commands/open-browser.ts";
import { useDesktopFlags } from "../state/useDesktopFlags.ts";
import { useWorkbench } from "../workbench/context.tsx";

export function BrowserNoticeAction() {
    const { layout, hidden, run } = useWorkbench();
    const flags = useDesktopFlags();
    if (window.veraDesktop === undefined || flags.browser === "off" || hidden.has(OPEN_BROWSER_COMMAND) || !canOpenBrowser(layout)) return null;
    return <div className="run-notice"><button className="button" type="button" onClick={() => run(OPEN_BROWSER_COMMAND)}>Open Browser</button></div>;
}
