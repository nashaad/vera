import type { ReactElement } from "react";

import type { IconProps } from "../components/Icons.tsx";
import { OutputIcon, ServerIcon, SessionsIcon, ViewIcon } from "../components/Icons.tsx";

const ICONS: Readonly<Record<string, (props: IconProps) => ReactElement>> = {
    sessions: SessionsIcon,
    vera: ServerIcon,
    output: OutputIcon,
};

// A container names its icon; one this client does not draw gets the generic view icon.
export function ContainerIcon({ name, className }: { readonly name: string; readonly className?: string }) {
    const Draw = ICONS[name] ?? ViewIcon;
    return <Draw {...(className === undefined ? {} : { className })} />;
}
