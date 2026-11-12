import type { ReactNode } from "react";

export interface SettingRowProps {
    readonly name: string;
    readonly description: string;
    // The control on the right, when the row has one.
    readonly children?: ReactNode;
}

export function SettingRow({ name, description, children }: SettingRowProps) {
    return (
        <div className="setting">
            <div className="setting-body">
                <div className="setting-name">{name}</div>
                <div className="setting-desc">{description}</div>
            </div>
            {children}
        </div>
    );
}
