import type { ElementType } from 'react';
import parse, { attributesToProps, domToReact, Element, type DOMNode, type HTMLReactParserOptions } from 'html-react-parser';
import { ConversationDiagram } from './conversation-diagram';
import { DirectoryExplorer } from './directory-explorer';
import { ScreenSteps } from './screen-steps';
import defaultComponents from 'fumadocs-ui/mdx';
import { Callout, type CalloutType } from 'fumadocs-ui/components/callout';

const components: Record<string, ElementType> = defaultComponents;

interface ContentProps {
    html: string;
    showEarlyAccess: boolean;
}

function buildOptions(showEarlyAccess: boolean): HTMLReactParserOptions {
    const options: HTMLReactParserOptions = {
        replace(node) {
            if (!(node instanceof Element)) return;
            // A marked section follows the sidebar's early access switch.
            if (node.attribs['data-early-access'] !== undefined && !showEarlyAccess) return <></>;
            if (node.attribs['data-diagram'] === 'conversation-loop') return <ConversationDiagram />;
            if (node.attribs['data-widget'] === 'directory-explorer') return <DirectoryExplorer />;
            if (node.attribs['data-widget'] === 'screen-steps') return <ScreenSteps name={node.attribs['data-steps'] ?? ''} />;
            const callout = node.attribs['data-callout'];
            if (callout) return <Callout type={callout as CalloutType} title={node.attribs['data-title']} className="manual-callout">{domToReact(node.children as DOMNode[], options)}</Callout>;
            const Component = components[node.name];
            if (!Component) return;
            // Void tags such as img make React throw if they get any children, even an empty array.
            if (node.children.length === 0) return <Component {...attributesToProps(node.attribs)} />;
            return (
                <Component {...attributesToProps(node.attribs)}>
                    {domToReact(node.children as DOMNode[], options)}
                </Component>
            );
        },
    };
    return options;
}

// Each marked section names the heading ids it owns, so the table of contents hides with it.
const EARLY_ACCESS_ATTRIBUTE = /data-early-access="([^"]*)"/g;

export function earlyAccessHeadings(html: string): Set<string> {
    const ids = new Set<string>();
    for (const match of html.matchAll(EARLY_ACCESS_ATTRIBUTE)) {
        for (const id of match[1]!.split(',')) {
            const trimmed = id.trim();
            if (trimmed !== '') ids.add(trimmed);
        }
    }
    return ids;
}

export function Content({ html, showEarlyAccess }: ContentProps) {
    return parse(html, buildOptions(showEarlyAccess));
}
