import type { IconProps } from "./Icons.tsx";

export function PointerIcon({ className }: IconProps) {
    return <svg className={className === undefined ? "icon" : `icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true"><path d="m5 3 15 10-7 1-3 7-5-18Z" /></svg>;
}
