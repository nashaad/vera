import type { ElementType } from 'react';
import parse, { attributesToProps, domToReact, Element, type DOMNode, type HTMLReactParserOptions } from 'html-react-parser';
import { ConversationDiagram } from './conversation-diagram';
import defaultComponents from 'fumadocs-ui/mdx';

const components: Record<string, ElementType> = defaultComponents;
interface ContentProps {
    html: string;
}

const options: HTMLReactParserOptions = {
    replace(node) {
        if (!(node instanceof Element)) return;
        if (node.attribs['data-diagram'] === 'conversation-loop') return <ConversationDiagram />;
        const Component = components[node.name];
        if (!Component) return;
        return (
            <Component {...attributesToProps(node.attribs)}>
                {domToReact(node.children as DOMNode[], options)}
            </Component>
        );
    },
};

export function Content({ html }: ContentProps) {
    return parse(html, options);
}
