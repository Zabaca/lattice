import { visit } from 'unist-util-visit';
import type { Root, Element } from 'hast';

/**
 * Rehype plugin that strips .md extensions from relative links.
 * This allows standard markdown links like [text](./file.md) to work
 * correctly in Astro where routes don't include the .md extension.
 */
export default function rehypeStripMdExtension() {
  return (tree: Root) => {
    visit(tree, 'element', (node: Element) => {
      if (
        node.tagName === 'a' &&
        typeof node.properties?.href === 'string'
      ) {
        const href = node.properties.href;
        // Only process relative links ending in .md
        if (
          !href.startsWith('http://') &&
          !href.startsWith('https://') &&
          !href.startsWith('//') &&
          href.endsWith('.md')
        ) {
          node.properties.href = href.slice(0, -3);
        }
      }
    });
  };
}
