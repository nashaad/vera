import { nativeCommand } from "./native.ts";
import { useSlotStore } from "./slots.ts";

interface BrowserToolsNoticeProps {
    readonly enabled: boolean;
    readonly available: boolean;
    readonly onTurnOff: () => void;
    readonly toolsAsk?: { readonly id: string };
}

export function BrowserToolsNotice({ enabled, available, onTurnOff, toolsAsk }: BrowserToolsNoticeProps) {
    if (toolsAsk !== undefined) {
        return (
            <div className="browser-tools-notice" role="status">
                <span>Vera wants to use the Browser pane. Turn on Browser tools?</span>
                <button type="button" className="chip chip-button" onClick={() => void nativeCommand("tools-approval", { id: toolsAsk.id, approved: true })}>Turn on</button>
                <button type="button" className="chip chip-button" onClick={() => void nativeCommand("tools-approval", { id: toolsAsk.id, approved: false })}>Not now</button>
            </div>
        );
    }
    if (!enabled) return null;
    return (
        <div className="browser-tools-notice" role="status">
            <span>Browser tools are on. Vera can open, read and act on pages in the Browser.</span>
            <button type="button" className="chip chip-button" disabled={!available} onClick={onTurnOff}>Turn off</button>
        </div>
    );
}

export function BrowserToolsStatus() {
    const { native } = useSlotStore();
    return (
        <BrowserToolsNotice
            enabled={native?.toolsEnabled ?? false}
            available={native?.toolsAvailable ?? false}
            onTurnOff={() => void nativeCommand("tools", false)}
            toolsAsk={native?.toolsAsk}
        />
    );
}
