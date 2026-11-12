import type { CSSProperties, ReactNode } from "react";

import { CheckIcon, HandIcon, ShieldIcon, type IconProps } from "../components/Icons.tsx";
import { type ModeOption } from "../session/permissions.ts";

export interface ApprovalChoice {
    readonly key: string;
    readonly Icon: (props: IconProps) => ReactNode;
    readonly label: string;
    readonly description: string;
    readonly warn: boolean;
    readonly selected: boolean;
    readonly onSelect: () => void;
}

export interface ApprovalMenuProps {
    readonly choices: readonly ApprovalChoice[];
    // Rows below the choices, such as the session's standing permissions.
    readonly children?: ReactNode;
    readonly style?: CSSProperties;
}

export function modeChoices(
    options: readonly ModeOption[],
    current: string | undefined,
    onPick: (mode: string) => void,
): readonly ApprovalChoice[] {
    return options.map((option) => ({
        key: option.mode,
        Icon: option.mode === "ask" ? HandIcon : ShieldIcon,
        label: option.label,
        description: option.description,
        warn: option.warn,
        selected: option.mode === current,
        onSelect: () => onPick(option.mode),
    }));
}

// The list shared by the session pill and the New Chat pill.
export function ApprovalMenu({ choices, children, style }: ApprovalMenuProps) {
    return (
        <div className="approval-menu menu" role="menu" data-popover="above-start" style={style}>
            <div className="menu-label">How should tool calls be approved?</div>
            {choices.map((choice) => (
                <button
                    key={choice.key}
                    type="button"
                    role="menuitemradio"
                    aria-checked={choice.selected}
                    className={choice.warn ? "menu-item approval-item warn" : "menu-item approval-item"}
                    onClick={choice.onSelect}
                >
                    <choice.Icon className="approval-item-icon" />
                    <span className="approval-item-body">
                        <span className="approval-item-name">{choice.label}</span>
                        <span className="approval-item-desc">{choice.description}</span>
                    </span>
                    {choice.selected ? <CheckIcon className="menu-check approval-check" /> : <span className="menu-check" />}
                </button>
            ))}
            {children}
        </div>
    );
}
