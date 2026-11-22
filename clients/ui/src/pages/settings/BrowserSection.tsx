import { nativeCommand } from "../../browser/native.ts";
import { useSlotStore } from "../../browser/slots.ts";
import { Segmented } from "./Segmented.tsx";
import { SettingRow } from "./SettingRow.tsx";

const BEHAVIORS = ["ask", "refuse"] as const;
const BEHAVIOR_LABELS = { ask: "Ask me", refuse: "Refuse" } as const;

interface BrowserSettingsControlProps {
    readonly behavior: "ask" | "refuse";
    readonly available: boolean;
    readonly onChange: (behavior: "ask" | "refuse") => void;
}

export function BrowserSettingsControl({ behavior, available, onChange }: BrowserSettingsControlProps) {
    return (
        <SettingRow name="When Browser tools are off">
            <Segmented
                label="When Browser tools are off"
                options={BEHAVIORS}
                labels={BEHAVIOR_LABELS}
                value={behavior}
                disabled={!available}
                onChange={onChange}
            />
        </SettingRow>
    );
}

export function BrowserSection() {
    const { native } = useSlotStore();
    return (
        <>
            <h1>Browser</h1>
            <BrowserSettingsControl
                behavior={native?.toolsOffBehavior ?? "ask"}
                available={native?.toolsAvailable ?? false}
                onChange={(behavior) => void nativeCommand("toolsOffBehavior", behavior)}
            />
        </>
    );
}
