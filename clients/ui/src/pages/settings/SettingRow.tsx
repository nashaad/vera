import type { ReactNode } from "react";

import { useSearchHit } from "./RowHighlight.tsx";

export interface SettingRowProps {
    // Matches a row in SETTINGS_ROWS, so the search can find this row on screen.
    readonly id?: string;
    readonly name: string;
    readonly description?: string;
    // The control on the right, when the row has one.
    readonly children?: ReactNode;
}

export function SettingRow({ id, name, description, children }: SettingRowProps) {
    const searchHit = useSearchHit(id);
    return (
        <div className="setting" {...(id === undefined ? {} : { "data-setting-id": id })} {...searchHit}>
            <div className="setting-body">
                <div className="setting-name">{name}</div>
                {description === undefined || description === "" ? null : <div className="setting-desc">{description}</div>}
            </div>
            {children}
        </div>
    );
}
