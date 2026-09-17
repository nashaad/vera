import { createFromSource } from 'fumadocs-core/search/server';
import { structure } from 'fumadocs-core/mdx-plugins';
import { getSource } from '../lib/source';

export async function GET() {
    const source = await getSource();
    const search = createFromSource(source, {
        buildIndex: (page) => ({
            id: page.url,
            title: page.data.title,
            url: page.url,
            structuredData: structure(page.data.entry.body ?? ''),
        }),
    });
    return search.staticGET();
}
