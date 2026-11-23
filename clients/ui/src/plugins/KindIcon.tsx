import type { ReactElement } from "react";

import {
    AgentIcon,
    BlocksIcon,
    BoltIcon,
    ClockIcon,
    FileIcon,
    LayersIcon,
    type IconProps,
} from "../components/Icons.tsx";
import type { CustomizeKind } from "../customize/catalog.ts";

type KindIconComponent = (props: IconProps) => ReactElement;

const KIND_ICONS: Readonly<Record<CustomizeKind, KindIconComponent>> = {
    skills: BoltIcon,
    agents: AgentIcon,
    extensions: LayersIcon,
    instructions: FileIcon,
    memory: ClockIcon,
    plugins: BlocksIcon,
};

export function KindIcon({ kind, className }: IconProps & { readonly kind: CustomizeKind }) {
    const Icon = KIND_ICONS[kind];
    return <Icon className={className} />;
}
