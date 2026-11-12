import { GaugeIcon } from "../components/Icons.tsx";
import { useViewEnvironment } from "../views/env.tsx";
import { useActiveSession } from "../session/activeSession.ts";
import { showToast } from "./toasts.ts";
import { OverlaySheet } from "./OverlaySheet.tsx";
import { diagnosticFacts, diagnosticsText, type DiagnosticFact, type DiagnosticSection } from "./diagnostics.ts";

export interface DiagnosticsSheetProps {
    readonly onClose: () => void;
}

const SECTIONS: readonly DiagnosticSection[] = ["Session", "Host"];

export function DiagnosticsSheet({ onClose }: DiagnosticsSheetProps) {
    const { connection } = useViewEnvironment();
    const session = useActiveSession();
    const facts = diagnosticFacts(session, connection, window.veraDesktop?.platform ?? "");

    const copy = () => {
        navigator.clipboard.writeText(diagnosticsText(facts)).then(
            () => showToast("Diagnostics copied", "success"),
            () => showToast("Could not copy the diagnostics", "danger"),
        );
    };

    return (
        <OverlaySheet
            title="Session Diagnostics"
            Icon={GaugeIcon}
            onClose={onClose}
            name="diagnostics"
            wide
            foot={(
                <button type="button" className="ghost-btn" onClick={copy}>Copy</button>
            )}
        >
            {session === undefined ? (
                <p className="dialog-text">No session is open, so only the host facts are shown.</p>
            ) : null}
            <table className="dialog-facts">
                <tbody>
                    {SECTIONS.map((section) => (
                        <FactSection key={section} section={section} facts={facts.filter((fact) => fact.section === section)} />
                    ))}
                </tbody>
            </table>
        </OverlaySheet>
    );
}

interface FactSectionProps {
    readonly section: DiagnosticSection;
    readonly facts: readonly DiagnosticFact[];
}

function FactSection({ section, facts }: FactSectionProps) {
    if (facts.length === 0) return null;
    return (
        <>
            <tr className="dialog-facts-section">
                <th colSpan={2} scope="colgroup">{section}</th>
            </tr>
            {facts.map((fact) => (
                <tr key={fact.label}>
                    <th scope="row">{fact.label}</th>
                    <td>{fact.value}</td>
                </tr>
            ))}
        </>
    );
}
