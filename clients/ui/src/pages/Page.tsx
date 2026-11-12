import type { ReactNode } from "react";

import type { IconProps } from "../components/Icons.tsx";

export interface PageProps {
    readonly title: string;
    readonly lede: string;
    readonly Icon: (props: IconProps) => ReactNode;
    readonly children?: ReactNode;
    readonly wide?: boolean;
    readonly actions?: ReactNode;
}

// The frame every page but New Chat shares: a heading, one line about the page, then its body.
export function Page({ title, lede, Icon, children, wide = false, actions }: PageProps) {
    const heading = (
        <h1 className="page-title">
            <Icon className="page-title-icon" />
            {title}
        </h1>
    );
    return (
        <div className="page-scroll">
            <div className="page">
                <div className="page-inner" data-wide={wide}>
                    {actions === undefined ? heading : (
                        <div className="page-head">
                            {heading}
                            {actions}
                        </div>
                    )}
                    <p className="page-lede">{lede}</p>
                    {children}
                </div>
            </div>
        </div>
    );
}

export interface EmptyStateProps {
    readonly title: string;
    readonly children: ReactNode;
}

export function EmptyState({ title, children }: EmptyStateProps) {
    return (
        <div className="empty-state">
            <h2 className="empty-state-title">{title}</h2>
            <p className="empty-state-text">{children}</p>
        </div>
    );
}
