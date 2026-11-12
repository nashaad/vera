import { useEffect, useRef } from "react";

import { LayersIcon, XIcon } from "../../components/Icons.tsx";

const STEPS = ["Pick", "Key", "Models"] as const;

interface ProviderWizardProps {
    readonly onClose: () => void;
}

// The steps are shown for orientation only; this window does not run them.
export function ProviderWizard({ onClose }: ProviderWizardProps) {
    const closeButton = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            onClose();
        };
        window.addEventListener("keydown", onKey);
        closeButton.current?.focus();
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    return (
        <div
            className="wizard-scrim"
            onClick={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div className="wizard-sheet" role="dialog" aria-modal="true" aria-label="Connect a provider">
                <header className="wizard-head">
                    <LayersIcon className="wizard-head-icon" />
                    <h2 className="wizard-title">Connect a provider</h2>
                    <button ref={closeButton} type="button" className="wizard-close" aria-label="Close" onClick={onClose}>
                        <XIcon className="wizard-close-icon" />
                    </button>
                </header>
                <ol className="wizard-steps" aria-label="Steps">
                    {STEPS.map((step, index) => (
                        <li key={step} className="wizard-step">
                            <span className="wizard-step-index">{index + 1}</span>
                            {step}
                        </li>
                    ))}
                </ol>
                <div className="wizard-body">
                    <p className="wizard-note">
                        This window does not add providers. Run <code>vera</code> in a terminal and use{" "}
                        <code>/provider</code>; it walks through the same steps and the provider appears here.
                    </p>
                </div>
                <footer className="wizard-foot">
                    <button type="button" className="button" onClick={onClose}>Close</button>
                </footer>
            </div>
        </div>
    );
}
