import manualLinks from './src/manual-links.mjs';
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { unified } from '@astrojs/markdown-remark';

export default defineConfig({
    markdown: { processor: unified({ remarkPlugins: [manualLinks] }) },
    integrations: [react()],
    vite: {
        server: { strictPort: true },
        plugins: [tailwindcss()],
        ssr: { noExternal: ['fumadocs-core', 'fumadocs-ui'] },
    },
});
