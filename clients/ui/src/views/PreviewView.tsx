import { useActiveSession } from "../session/activeSession.ts";
import type { ViewProps } from "./env.tsx";

export function PreviewView(_props: ViewProps) {
    const session = useActiveSession();
    if (session === undefined) return <p className="view-empty">Open a session to see its preview.</p>;
    return <p className="view-empty">The host does not serve previews.</p>;
}
