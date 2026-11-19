import { SearchIcon } from "../../../components/Icons.tsx";
import type { ModelEntry } from "../../../models/settings.ts";

interface ModelStepProps {
    readonly models: readonly ModelEntry[];
    readonly model: string;
    readonly query: string;
    readonly onModelChange: (model: string) => void;
    readonly onQueryChange: (query: string) => void;
}

function modelDetail(entry: ModelEntry): string {
    if (entry.contextWindow !== undefined) return `${entry.contextWindow.toLocaleString()} context`;
    if (entry.pricing !== undefined) return `$${entry.pricing.input} / $${entry.pricing.output}`;
    return "";
}

export function ModelStep({ models, model, query, onModelChange, onQueryChange }: ModelStepProps) {
    const visible = models.filter((entry) => `${entry.label} ${entry.model}`.toLowerCase().includes(query.toLowerCase()));
    return (
        <div className="provider-wizard-model-step">
            <div className="provider-wizard-model-search"><SearchIcon /><input autoFocus aria-label="Search models" placeholder="Search models" value={query} onChange={(event) => onQueryChange(event.target.value)} /></div>
            <div className="provider-wizard-model-list" role="radiogroup" aria-label="Model">
                {visible.map((entry) => <label className="provider-wizard-model-row" key={entry.model}>
                    <input type="radio" name="provider-model" checked={model === entry.model} onChange={() => onModelChange(entry.model)} />
                    <span>{entry.label}</span><span className="provider-wizard-model-detail">{modelDetail(entry)}</span>
                </label>)}
            </div>
        </div>
    );
}
