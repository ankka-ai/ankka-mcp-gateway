import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const documents = [
  'README.md',
  'docs/README.md',
  'docs/CUSTOMER_SELF_SERVICE.md',
  'docs/SECURITY_MODEL.md',
  'docs/FIRST_SOURCE_ONBOARDING.md',
];

function read(path) {
  return readFileSync(new URL(path, root), 'utf8');
}

// These entry-point documents use inline Markdown links and plain GitHub
// headings. Keep this check deliberately scoped, not a general Markdown parser.
function anchors(markdown) {
  const result = new Set([...markdown.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]));
  const counts = new Map();
  for (const match of markdown.matchAll(/^#{1,6} (.+)$/gm)) {
    const slug = match[1].toLowerCase().replace(/[`*_~]/g, '')
      .replace(/[^\p{L}\p{N}_\- ]/gu, '').replaceAll(' ', '-');
    const count = counts.get(slug) ?? 0;
    result.add(count ? `${slug}-${count}` : slug);
    counts.set(slug, count + 1);
  }
  return result;
}

test('documentation entry points have resolving relative files and Markdown anchors', () => {
  for (const document of documents) {
    const source = read(document);
    for (const match of source.matchAll(/(?<!!)\[[^\]]+\]\(([^\s)]+)\)/g)) {
      const href = match[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
      const target = new URL(href, new URL(document, root));
      assert.ok(target.href.startsWith(root.href), `${document}: link escapes repository`);
      const fragment = target.hash.slice(1);
      target.hash = '';
      const stat = statSync(target);
      assert.ok(stat.isDirectory() || stat.isFile(), `${document}: ${href}`);
      if (fragment && extname(target.pathname) === '.md') {
        assert.ok(anchors(readFileSync(target, 'utf8')).has(decodeURIComponent(fragment)), `${document}: missing ${href}`);
      }
    }
  }
});
