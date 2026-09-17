import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

export const collections = {
    docs: defineCollection({
        loader: glob({ pattern: '*.md', base: '..' }),
        schema: z.object({
            title: z.string(),
            description: z.string().optional(),
            draft: z.boolean().default(false),
            replay: z.enum(['model-picker']).optional(),
            layout: z.enum(['manual', 'homepage']).default('manual'),
        }),
    }),
};
