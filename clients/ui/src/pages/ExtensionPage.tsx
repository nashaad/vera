import { PageFrame } from "../views/PageFrame.tsx";
import type { ExtensionRoute } from "./routes.ts";

// A page an extension gave a pane, opened full size from the sidebar. It shows the page without a query.
export function ExtensionPage({ route }: { readonly route: ExtensionRoute }) {
    return <PageFrame path={route.path} />;
}
