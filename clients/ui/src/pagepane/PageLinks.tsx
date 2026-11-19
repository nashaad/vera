import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from "react";

import type { AnnexPagesAnswer } from "../protocol/bridge.ts";
import { useWorkbench } from "../workbench/context.tsx";
import { splitAddresses, annexLink, type AnnexLink } from "./links.ts";
import { openAnnexPath } from "./open.ts";

interface PageLinks {
    // The pages the host's annex serves; undefined until the window has read them.
    readonly annex: AnnexPagesAnswer | undefined;
    readonly open: (link: AnnexLink) => void;
}

const PageLinksContext = createContext<PageLinks>({ annex: undefined, open: () => undefined });

export function usePageLinks(): PageLinks {
    return useContext(PageLinksContext);
}

// Lets text anywhere in the window open a page of the host's annex inside the window.
export function PageLinksProvider({ annex, children }: { readonly annex: AnnexPagesAnswer | undefined; readonly children: ReactNode }) {
    const workbench = useWorkbench();
    const latest = useRef(workbench);
    latest.current = workbench;
    const open = useCallback((link: AnnexLink) => openAnnexPath(latest.current, link.page, link.path), []);
    const value = useMemo(() => ({ annex, open }), [annex, open]);
    return <PageLinksContext.Provider value={value}>{children}</PageLinksContext.Provider>;
}

interface PageLinkProps {
    readonly href: string;
    readonly children: ReactNode;
    // Text that was not written as a link stays plain when it names no page.
    readonly bare?: boolean;
}

// A link that opens a page of the host's annex in the window when `href` names one, and is otherwise inert.
export function PageLink({ href, children, bare = false }: PageLinkProps) {
    const { annex, open } = usePageLinks();
    const link = annexLink(href, annex);
    if (link === undefined) {
        return bare ? <>{children}</> : <a href={href} title={href} onClick={(event) => event.preventDefault()}>{children}</a>;
    }
    return (
        <a
            href={href}
            title={href}
            data-page-link={link.page.path}
            onClick={(event) => {
                event.preventDefault();
                open(link);
            }}
        >
            {children}
        </a>
    );
}

// Text with each loopback address in it drawn as a PageLink.
export function LinkedText({ text }: { readonly text: string }) {
    return (
        <>
            {splitAddresses(text).map((part, index) => (part.kind === "text"
                ? part.text
                : <PageLink key={index} href={part.url} bare>{part.url}</PageLink>))}
        </>
    );
}
