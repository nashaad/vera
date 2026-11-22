import type { DefaultBrowser } from "../../browser/native-types.ts";
import { nativeCommand } from "../../browser/native.ts";
import { useSlotStore } from "../../browser/slots.ts";
import { Segmented } from "./Segmented.tsx";
import { SettingRow } from "./SettingRow.tsx";

const BEHAVIORS = ["ask", "refuse"] as const;
const BEHAVIOR_LABELS = { ask: "Ask me", refuse: "Refuse" } as const;
const DEFAULT_BROWSERS = ["pane", "chrome", "ask"] as const;
const DEFAULT_BROWSER_LABELS = { pane: "Browser pane", chrome: "Chrome", ask: "Ask each chat" } as const;

interface BrowserSettingsControlProps {
    readonly behavior: "ask" | "refuse";
    readonly defaultBrowser: DefaultBrowser;
    readonly available: boolean;
    readonly onChange: (behavior: "ask" | "refuse") => void;
    readonly onDefaultBrowserChange: (browser: DefaultBrowser) => void;
}

export function BrowserSettingsControl({ behavior, defaultBrowser, available, onChange, onDefaultBrowserChange }: BrowserSettingsControlProps) {
    return (
        <>
            <SettingRow id="browser.tools-off" name="When Browser tools are off">
                <Segmented
                    label="When Browser tools are off"
                    options={BEHAVIORS}
                    labels={BEHAVIOR_LABELS}
                    value={behavior}
                    disabled={!available}
                    onChange={onChange}
                />
            </SettingRow>
            <SettingRow id="browser.default-browser" name="Default browser">
                <Segmented
                    label="Default browser"
                    options={DEFAULT_BROWSERS}
                    labels={DEFAULT_BROWSER_LABELS}
                    value={defaultBrowser}
                    disabled={!available}
                    onChange={onDefaultBrowserChange}
                />
            </SettingRow>
        </>
    );
}

export function BrowserSection() {
    const { native } = useSlotStore();
    return (
        <>
            <h1>Browser</h1>
            <BrowserSettingsControl
                behavior={native?.toolsOffBehavior ?? "ask"}
                defaultBrowser={native?.defaultBrowser ?? "ask"}
                available={native?.toolsAvailable ?? false}
                onChange={(behavior) => void nativeCommand("toolsOffBehavior", behavior)}
                onDefaultBrowserChange={(browser) => void nativeCommand("defaultBrowser", browser)}
            />
        </>
    );
}
