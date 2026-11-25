import { defineCollection, z } from 'astro:content';
import { docsLoader, i18nLoader } from '@astrojs/starlight/loaders';
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema';
export const collections = {
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema({ extend: z.object({
    pageId: z.string().regex(/^rk-[a-z][a-z0-9-]{2,63}$/),
    docType: z.enum(['landing', 'tutorial', 'how-to', 'reference', 'explanation']),
    productArea: z.enum(['overview', 'mail', 'chat', 'account', 'calendar', 'agents', 'meetings', 'platforms']),
    appliesTo: z.array(z.string()).min(1),
    reviewed: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    behaviorChecked: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  }) }) }),
};
