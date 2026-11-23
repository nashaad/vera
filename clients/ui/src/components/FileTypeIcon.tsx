import { splitChangePath } from "../session/gitChanges.ts";

interface FileType {
    readonly label: string;
    readonly kind: string;
}

const BY_EXTENSION: Readonly<Record<string, FileType>> = {
    ts: { label: "TS", kind: "typescript" },
    tsx: { label: "TS", kind: "typescript" },
    mts: { label: "TS", kind: "typescript" },
    cts: { label: "TS", kind: "typescript" },
    js: { label: "JS", kind: "javascript" },
    jsx: { label: "JS", kind: "javascript" },
    mjs: { label: "JS", kind: "javascript" },
    cjs: { label: "JS", kind: "javascript" },
    json: { label: "{}", kind: "json" },
    jsonc: { label: "{}", kind: "json" },
    md: { label: "MD", kind: "markdown" },
    mdx: { label: "MD", kind: "markdown" },
    css: { label: "CSS", kind: "style" },
    scss: { label: "CSS", kind: "style" },
    less: { label: "CSS", kind: "style" },
    html: { label: "<>", kind: "markup" },
    htm: { label: "<>", kind: "markup" },
    xml: { label: "<>", kind: "markup" },
    svg: { label: "SVG", kind: "image" },
    png: { label: "IMG", kind: "image" },
    jpg: { label: "IMG", kind: "image" },
    jpeg: { label: "IMG", kind: "image" },
    gif: { label: "IMG", kind: "image" },
    webp: { label: "IMG", kind: "image" },
    yml: { label: "YML", kind: "config" },
    yaml: { label: "YML", kind: "config" },
    toml: { label: "TML", kind: "config" },
    sh: { label: "SH", kind: "shell" },
    bash: { label: "SH", kind: "shell" },
    zsh: { label: "SH", kind: "shell" },
    py: { label: "PY", kind: "python" },
    go: { label: "GO", kind: "go" },
    rs: { label: "RS", kind: "rust" },
    lock: { label: "LK", kind: "lock" },
};

export function fileType(path: string): FileType {
    const { name } = splitChangePath(path);
    const dot = name.lastIndexOf(".");
    const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
    return BY_EXTENSION[extension] ?? { label: "·", kind: "file" };
}

// A file type tag drawn from theme tokens, so every theme colors it the same way.
export function FileTypeIcon({ path, className }: { readonly path: string; readonly className?: string }) {
    const type = fileType(path);
    return (
        <span className={`file-type-icon${className === undefined ? "" : ` ${className}`}`} data-kind={type.kind} aria-hidden="true">
            {type.label}
        </span>
    );
}
