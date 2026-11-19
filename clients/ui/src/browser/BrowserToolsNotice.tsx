import { nativeCommand } from "./native.ts";
import { useSlotStore } from "./slots.ts";

interface BrowserToolsNoticeProps {
    readonly enabled: boolean;
    readonly available: boolean;
    readonly onTurnOff: () => void;
}

export function BrowserToolsNotice({ enabled, available, onTurnOff }: BrowserToolsNoticeProps) {
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
        />
    );
}
