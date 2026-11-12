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
