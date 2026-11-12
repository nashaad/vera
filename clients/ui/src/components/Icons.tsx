import type { ReactNode } from "react";

export interface IconProps {
    readonly className?: string;
}

function Icon({ className, children }: IconProps & { readonly children: ReactNode }) {
    return (
        <svg
            className={className === undefined ? "icon" : `icon ${className}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            {children}
        </svg>
    );
}

export function InfoIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v5" />
            <path d="M12 8h.01" />
        </Icon>
    );
}

export function WarningIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="M12 4 3 19h18L12 4Z" />
            <path d="M12 10v4" />
            <path d="M12 17h.01" />
        </Icon>
    );
}

export function ErrorIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <circle cx="12" cy="12" r="9" />
            <path d="m9 9 6 6" />
            <path d="m15 9-6 6" />
        </Icon>
    );
}

export function RemoteIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="m8 7-5 5 5 5" />
            <path d="m16 7 5 5-5 5" />
        </Icon>
    );
}

export function SidebarIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M9 4v16" />
        </Icon>
    );
}

export function SidebarRightIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M15 4v16" />
        </Icon>
    );
}

export function PanelIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M3 14h18" />
        </Icon>
    );
}

export function SessionsIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9l-4 4v-4H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" />
        </Icon>
    );
}

export function ServerIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <rect x="3" y="4" width="18" height="7" rx="2" />
            <rect x="3" y="13" width="18" height="7" rx="2" />
            <path d="M7 7.5h.01" />
            <path d="M7 16.5h.01" />
        </Icon>
    );
}

export function FolderIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="M4 6a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6Z" />
        </Icon>
    );
}

export function OutputIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="m5 8 4 4-4 4" />
            <path d="M12 16h7" />
        </Icon>
    );
}

export function ViewIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="m12 4-9 5 9 5 9-5-9-5Z" />
            <path d="m3 14 9 5 9-5" />
        </Icon>
    );
}

export function MoreIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <circle cx="5" cy="12" r="1" fill="currentColor" />
            <circle cx="12" cy="12" r="1" fill="currentColor" />
            <circle cx="19" cy="12" r="1" fill="currentColor" />
        </Icon>
    );
}

export function ChevronRightIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="m9 6 6 6-6 6" />
        </Icon>
    );
}

export function ChevronDownIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="m6 9 6 6 6-6" />
        </Icon>
    );
}

export function CheckIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="m5 12 5 5 9-10" />
        </Icon>
    );
}

export function ComposeIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" />
            <path d="m17.5 3.5 3 3L12 15l-4 1 1-4 8.5-8.5Z" />
        </Icon>
    );
}

export function SearchIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
        </Icon>
    );
}

export function BellIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 13 6 9Z" />
            <path d="M10 18.5a2 2 0 0 0 4 0" />
        </Icon>
    );
}

export function BlocksIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <rect x="3" y="3" width="7" height="7" rx="1.5" />
            <rect x="14" y="3" width="7" height="7" rx="1.5" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" />
            <path d="M14 17.5h7" />
            <path d="M17.5 14v7" />
        </Icon>
    );
}

export function ArrowLeftIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="M19 12H5" />
            <path d="m11 6-6 6 6 6" />
        </Icon>
    );
}

export function ArrowRightIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="M5 12h14" />
            <path d="m13 6 6 6-6 6" />
        </Icon>
    );
}

export function GearIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <circle cx="12" cy="12" r="3" />
            <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" />
        </Icon>
    );
}

export function CopyIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <rect x="9" y="9" width="12" height="12" rx="2" />
            <path d="M5 15V5a2 2 0 0 1 2-2h8" />
        </Icon>
    );
}

export function LaptopIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <rect x="4" y="5" width="16" height="11" rx="2" />
            <path d="M2 19h20" />
        </Icon>
    );
}

export function BranchIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <circle cx="7" cy="5.5" r="2.5" />
            <circle cx="7" cy="18.5" r="2.5" />
            <circle cx="17" cy="9" r="2.5" />
            <path d="M7 8v8M17 11.5c0 3-4 2.5-6 4.5" />
        </Icon>
    );
}

export function ArrowUpIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="M12 19V5" />
            <path d="m6 11 6-6 6 6" />
        </Icon>
    );
}

export function SquareIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
        </Icon>
    );
}

export function ListIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="M8 6h13M8 12h13M8 18h13" />
            <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
        </Icon>
    );
}

export function PlusIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="M12 5v14M5 12h14" />
        </Icon>
    );
}

export function XIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="M6 6l12 12M18 6L6 18" />
        </Icon>
    );
}

export function ImageIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <rect x="3" y="4" width="18" height="16" rx="2.5" />
            <circle cx="8.5" cy="9.5" r="1.5" />
            <path d="m4 17 5-5 4 4 3-2 4 4" />
        </Icon>
    );
}

export function HandIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12" />
            <path d="M11 11.5V4a1.5 1.5 0 0 1 3 0v7.5" />
            <path d="M14 11.5V6a1.5 1.5 0 0 1 3 0v8.5a6.5 6.5 0 0 1-6.5 6.5h-.6a6 6 0 0 1-4.6-2.2L3.6 16a1.5 1.5 0 0 1 2.3-1.9L8 16" />
        </Icon>
    );
}

export function ShieldIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="M12 3 5 6v5.5c0 4.3 2.9 8 7 9.5 4.1-1.5 7-5.2 7-9.5V6z" />
        </Icon>
    );
}

export function QuestionIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <circle cx="12" cy="12" r="9" />
            <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7" />
            <path d="M12 17h.01" />
        </Icon>
    );
}

export function TerminalIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <rect x="3" y="4" width="18" height="16" rx="2.5" />
            <path d="m7 9 3 3-3 3M12.5 15H17" />
        </Icon>
    );
}

export function BoltIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="M13 3 5 14h6l-1 7 8-11h-6l1-7Z" />
        </Icon>
    );
}

export function PinIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="M9 4h6" />
            <path d="M10 4v5l-3 4h10l-3-4V4" />
            <path d="M12 13v7" />
        </Icon>
    );
}

export function LayersIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="m12 4 9 5-9 5-9-5 9-5Z" />
            <path d="m3 14 9 5 9-5" />
        </Icon>
    );
}

export function KeyIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <circle cx="8" cy="15" r="4" />
            <path d="m11 12 8-8" />
            <path d="m16 7 3 3" />
        </Icon>
    );
}

export function RefreshIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="M20 12a8 8 0 1 1-2.3-5.6" />
            <path d="M20 4v5h-5" />
        </Icon>
    );
}

export function ProbeIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="M4 12h4l2-5 4 10 2-5h4" />
        </Icon>
    );
}

export function GaugeIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="M4 18a8 8 0 1 1 16 0" />
            <path d="m12 14 4-4" />
        </Icon>
    );
}

export function RewindIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="M20 11a8 8 0 1 0-2 6.5" />
            <path d="M20 5v6h-6" />
        </Icon>
    );
}

export function AgentIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <rect x="4" y="8" width="16" height="12" rx="3" />
            <path d="M12 4v4" />
            <path d="M9 14h.01" />
            <path d="M15 14h.01" />
        </Icon>
    );
}

export function FileIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
            <path d="M14 3v5h5" />
        </Icon>
    );
}

export function EyeIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
            <circle cx="12" cy="12" r="2.5" />
        </Icon>
    );
}

export function DiffIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="M8 4v10" />
            <path d="M3 9h10" />
            <path d="M11 19h10" />
        </Icon>
    );
}

export function InboxIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="M3 13h5l1.5 3h5L16 13h5" />
            <path d="M5 5h14l2 8v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z" />
        </Icon>
    );
}

export function ClockIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <circle cx="12" cy="12" r="8.5" />
            <path d="M12 7.5V12l3 2" />
        </Icon>
    );
}

export function ColumnsIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <rect x="3" y="4" width="18" height="16" rx="2.5" />
            <path d="M12 4v16" />
        </Icon>
    );
}

export function PlayIcon({ className }: IconProps) {
    return (
        <Icon className={className}>
            <path d="M8 5.5v13l10.5-6.5z" />
        </Icon>
    );
}
