import { useViewEnvironment } from "../../views/env.tsx";

// The host listens on a local socket only, so the list has one row.
export function DevicesSection() {
    const { connection } = useViewEnvironment();
    const attached = connection.phase === "attached";
    const since = connection.ready === undefined
        ? undefined
        : new Date(connection.ready.attachedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return (
        <>
            <h1>Devices</h1>
            <p className="settings-lede">What can reach this machine, and what is talking to Vera right now.</p>
            <h2 className="settings-sec">Trusted devices</h2>
            <p className="settings-muted">No other device can reach this host. Vera listens on a local socket on this machine.</p>
            <h2 className="settings-sec">Active connections</h2>
            {attached ? (
                <table className="settings-grid">
                    <thead>
                        <tr>
                            <th>Client</th>
                            <th>Where</th>
                            <th>Since</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td>This window <span className="badge">Current</span></td>
                            <td><code>{connection.ready?.home ?? "Not known"}</code></td>
                            <td>{since ?? "Not known"}</td>
                        </tr>
                    </tbody>
                </table>
            ) : (
                <p className="settings-muted">This window is not attached to a host right now.</p>
            )}
            <p className="settings-muted">Other clients attached to this host are not listed.</p>
        </>
    );
}
