import { defineConfig } from 'astro/config';
import { astroSpaceship } from 'astro-spaceship';
import rehypeStripMdExtension from './src/plugins/rehype-strip-md-extension';

import websiteConfig from 'astro-spaceship/config';

export default defineConfig({
  markdown: {
    rehypePlugins: [rehypeStripMdExtension],
  },
  integrations: [
    astroSpaceship(websiteConfig)
  ]
});
