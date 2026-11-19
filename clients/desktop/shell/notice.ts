// The page the shell shows when it has no desktop package to load. The message is text, never markup.
export function noticePage(message: string): string {
    const escaped = message
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;");
    return `<!doctype html><html><head><meta charset="utf-8"><title>Vera</title>`
        + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`
        + `<style>html{color-scheme:dark light}body{margin:0;display:flex;align-items:center;justify-content:center;`
        + `min-height:100vh;padding:32px;box-sizing:border-box;font:15px/1.5 -apple-system,system-ui,sans-serif;`
        + `background:#0b0c10;color:#e8e9ee}p{max-width:420px;margin:0}</style></head>`
        + `<body><p>${escaped}</p></body></html>`;
}
