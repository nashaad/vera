import type { Root } from 'fumadocs-core/page-tree';
import type { TOCItemType } from 'fumadocs-core/toc';
import { RootProvider } from 'fumadocs-ui/provider/astro';
import { Banner } from 'fumadocs-ui/components/banner';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { DocsBody, DocsDescription, DocsPage, DocsTitle, MarkdownCopyButton, ViewOptionsPopover } from 'fumadocs-ui/layouts/docs/page';
import { Content } from './content';
import { ManualSearch } from './search';
import { TerminalReplay } from './terminal-replay';

const OUTBOUND_LINKS = [
    { text: 'Vera home', url: '/' },
    { text: 'Corvine Systems', url: 'https://corvines.com', external: true },
    { text: 'nashaad.com', url: 'https://nashaad.com', external: true },
];

interface ManualProps {
    tree: Root;
    title: string;
    description?: string;
    markdownUrl: string;
    pathname: string;
    toc: TOCItemType[];
    html: string;
    draft: boolean;
    replay?: 'conversation';
}

export function Manual({ tree, title, description, markdownUrl, pathname, toc, html, draft, replay }: ManualProps) {
    return (
        <RootProvider pathname={pathname} search={{ SearchDialog: ManualSearch }} theme={{ defaultTheme: 'dark' }}>
            <Banner className="manual-banner" height="3.75rem"><span aria-hidden="true">🚧</span><span className="manual-banner-tag">Wet paint</span>Vera is under heavy development. Try the code, just expect things to move.</Banner>
            <DocsLayout tree={tree} nav={{ title: 'Vera', url: '/manual/' }} links={OUTBOUND_LINKS}>
                <DocsPage
                    className="max-w-[calc(70ch+4rem)]"
                    toc={toc}
                    tableOfContent={{ style: 'normal', container: { className: 'manual-toc' } }}
                    tableOfContentPopover={{ style: 'normal', container: { className: 'manual-toc' } }}
                >
                    <DocsTitle>{title}</DocsTitle>
                    <DocsDescription>{description}</DocsDescription>
                    {draft && <p className="text-sm text-fd-muted-foreground">Preview page. Excluded from the public site.</p>}
                    <div className="flex flex-row flex-wrap items-center gap-2 border-b pt-2 pb-6">
                        <MarkdownCopyButton markdownUrl={markdownUrl} />
                        <ViewOptionsPopover markdownUrl={markdownUrl} />
                    </div>
                    <DocsBody>
                        <Content html={html} />
                        {replay && <TerminalReplay recording={replay} />}
                    </DocsBody>
                </DocsPage>
            </DocsLayout>
        </RootProvider>
    );
}
