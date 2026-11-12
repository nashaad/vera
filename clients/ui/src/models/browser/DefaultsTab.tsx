import type { ModelSettings } from "../settings.ts";
import { defaultRows } from "./rows.ts";

export interface DefaultsTabProps {
    readonly settings: ModelSettings;
}

export function DefaultsTab({ settings }: DefaultsTabProps) {
    return (
        <div className="models-plain">
            {defaultRows(settings).map((row) => (
                <div className="models-setting" key={row.label}>
                    <span className="models-setting-name">{row.label}</span>
                    <span className="models-setting-value">{row.value}</span>
                    {row.note !== undefined && <span className="models-setting-note">{row.note}</span>}
                </div>
            ))}
            <div className="models-section-title">Assignment slots</div>
            <div className="models-slots" aria-disabled="true" title="Not available yet">
                Choosing a model per job is not available yet.
            </div>
        </div>
    );
}
