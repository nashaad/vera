import { useEffect, useRef, useState } from "react";

import { AnnexChrome } from "./App.tsx";

interface BrowserPageModule {
    mount?(root: HTMLElement, context: { readonly api: string; readonly page: string }): void | (() => void);
}

export function ExtensionPageApp({ path }: { readonly path: string }) {
    const rootRef = useRef<HTMLDivElement>(null);
    const [failure, setFailure] = useState<string | undefined>();

    useEffect(() => {
        const root = rootRef.current;
        if (root === null) return;
        let unmount: (() => void) | undefined;
        let cancelled = false;
        // A runtime URL keeps the bundler from trying to resolve the page module.
        const source = `${path}/page.js`;
        void (import(/* @vite-ignore */ source) as Promise<BrowserPageModule>)
            .then((module) => {
                if (cancelled) return;
                if (typeof module.mount !== "function") {
                    setFailure("This page has no mount function.");
                    return;
                }
                const result = module.mount(root, { api: `${path}/api/`, page: path });
                if (typeof result === "function") unmount = result;
            })
            .catch((error: unknown) => {
                if (!cancelled) {
                    setFailure(error instanceof Error ? error.message : String(error));
                }
            });
        return () => {
            cancelled = true;
            unmount?.();
        };
    }, [path]);

    return (
        <div className="page">
            <AnnexChrome page={path} onHome={() => window.location.assign(path)} />
            {failure === undefined
                ? undefined
                : <p className="note">The page failed to load: {failure}</p>}
            <div ref={rootRef} />
        </div>
    );
}
