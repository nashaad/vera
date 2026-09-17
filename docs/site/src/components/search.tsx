import { useDocsSearch } from 'fumadocs-core/search/client';
import { staticClient } from 'fumadocs-core/search/client/orama-static';
import {
    SearchDialog,
    SearchDialogClose,
    SearchDialogContent,
    SearchDialogHeader,
    SearchDialogIcon,
    SearchDialogInput,
    SearchDialogList,
    SearchDialogOverlay,
    type SharedProps,
} from 'fumadocs-ui/components/dialog/search';

const client = staticClient({ from: '/search.json' });

export function ManualSearch(props: SharedProps) {
    const { search, setSearch, query } = useDocsSearch({ client });
    return (
        <SearchDialog {...props} search={search} onSearchChange={setSearch} isLoading={query.isLoading}>
            <SearchDialogOverlay />
            <SearchDialogContent>
                <SearchDialogHeader>
                    <SearchDialogIcon />
                    <SearchDialogInput />
                    <SearchDialogClose />
                </SearchDialogHeader>
                <SearchDialogList items={query.data === 'empty' ? null : query.data} />
            </SearchDialogContent>
        </SearchDialog>
    );
}
