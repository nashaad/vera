import type { ComponentType } from "react";

import { CheckIcon, ErrorIcon, InfoIcon, WarningIcon } from "../components/Icons.tsx";
import { dismissToast, useToasts, type ToastTone } from "./toasts.ts";

const TONE_ICON: Readonly<Record<ToastTone, ComponentType<{ readonly className?: string }>>> = {
    info: InfoIcon,
    success: CheckIcon,
    warning: WarningIcon,
    danger: ErrorIcon,
};

// The container stays mounted so the live region is in place before the first toast arrives.
export function Toasts() {
    const toasts = useToasts();
    return (
        <div className="toasts" role="status" aria-live="polite">
            {toasts.map((toast) => {
                const Icon = TONE_ICON[toast.tone];
                return (
                    <button
                        type="button"
                        key={toast.id}
                        className="toast"
                        data-tone={toast.tone}
                        onClick={() => dismissToast(toast.id)}
                    >
                        <span className="toast-icon" aria-hidden="true">
                            <Icon />
                        </span>
                        <span className="toast-text">{toast.text}</span>
                    </button>
                );
            })}
        </div>
    );
}
