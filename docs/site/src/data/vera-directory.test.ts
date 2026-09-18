import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { directoryTrees, type DirectoryNode } from './vera-directory';

const repo = join(import.meta.dir, '..', '..', '..', '..');

function documentPath(page: string): string {
    return page === 'llms.txt' ? join(repo, 'llms.txt') : join(repo, 'docs', `${page}.md`);
}

function flatten(nodes: DirectoryNode[]): DirectoryNode[] {
    return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

describe('Vera directory explorer data', () => {
    for (const tree of directoryTrees) {
        for (const node of flatten(tree.nodes)) {
            test(`${tree.name}: ${node.path} is documented in ${node.documentedIn}`, () => {
                const page = documentPath(node.documentedIn);
                expect(existsSync(page)).toBe(true);
                if (!readFileSync(page, 'utf8').includes(node.path)) {
                    throw new Error(`${node.path} does not appear in ${page}`);
                }
            });
        }
    }

    test('every entry in the factory home is in the Home tree', () => {
        const home = directoryTrees.find((tree) => tree.name === 'home');
        const names = new Set(home?.nodes.map((node) => node.name.replace(/\/$/, '')));
        const factory = readdirSync(join(repo, 'dev', 'factory-home')).filter((name) => !name.startsWith('.'));
        expect(factory.filter((name) => !names.has(name))).toEqual([]);
    });
});
