import type { CollectionEntry } from 'astro:content';
import { loader, type StaticSource, type MetaData } from 'fumadocs-core/source';
import { getManualEntries } from './visibility';

interface ManualPageData {
    title: string;
    description?: string;
    entry: CollectionEntry<'docs'>;
}

export async function getSource() {
    const entries = await getManualEntries();
    const index = entries.find((entry) => entry.id === 'index');
    if (!index) throw new Error('The manual requires docs/index.md');

    const publicIds = new Set(entries.filter((entry) => !entry.data.draft).map((entry) => entry.id));
    const pages = ['---Start here---', ...['index', 'getting-started'].filter((id) => publicIds.has(id))];
    const labels = new Map<string, string>([['index', 'Manual']]);
    for (const line of (index.body ?? '').split('\n')) {
        const heading = /^## (.+)$/.exec(line);
        const link = /^- \[([^\]]+)\]\(([^)]+)\.md\)$/.exec(line);
        if (heading) pages.push(`---${heading[1]}---`);
        if (link && publicIds.has(link[2]!)) {
            pages.push(link[2]!);
            labels.set(link[2]!, link[1]!);
        }
    }
    const drafts = entries.filter((entry) => entry.data.draft);
    if (drafts.length > 0) pages.push('---Preview---', ...drafts.map((entry) => entry.id));

    const source: StaticSource<{ pageData: ManualPageData; metaData: MetaData }> = {
        files: entries.map((entry) => ({
            type: 'page',
            path: `${entry.id}.md`,
            data: {
                title: labels.get(entry.id) ?? entry.data.title,
                description: entry.data.description,
                entry,
            },
        })),
    };
    source.files.push({ type: 'meta', path: 'meta.json', data: { pages } });
    return loader({ baseUrl: '/', source });
}
