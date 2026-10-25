import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Resolve the dependency that Next actually uses, not an unrelated hoisted copy.
const require = createRequire(import.meta.url);
const requireNext = createRequire(require.resolve('next/package.json'));
const postcss = requireNext('postcss');
const { version } = requireNext('postcss/package.json');

describe('Next PostCSS source-map boundary', () => {
  const marker = 'OWNED_SYNTHETIC_POSTCSS_MAP_MARKER';
  const style = 'a { color: red; display: flex; }';
  let directory;
  let input;
  let outsideMap;

  beforeEach(() => {
    // Every possible map target belongs to this fixture, including "outside".
    directory = mkdtempSync(join(tmpdir(), 'postcss-map-boundary-'));
    const cssDirectory = join(directory, 'css');
    mkdirSync(cssDirectory);
    input = join(cssDirectory, 'input.css');
    outsideMap = join(directory, 'outside.map');
    const map = JSON.stringify({
      version: 3,
      sources: ['synthetic-original.css'],
      names: [],
      mappings: 'AAAA',
      sourcesContent: [marker],
    });
    writeFileSync(outsideMap, map);
    writeFileSync(join(cssDirectory, 'input.css.map'), map);
  });

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  async function processMap(annotation, options = {}) {
    const result = await postcss().process(`${style}\n/*# sourceMappingURL=${annotation} */`, {
      from: undefined,
      ...options,
      map: { inline: false, annotation: false },
    });
    expect(result.map).toBeDefined();
    return result;
  }

  it('uses a stable patched 8.x release, at least 8.5.23', () => {
    expect(version).toMatch(/^8\.\d+\.\d+$/);
    const [, minor, patch] = version.split('.').map(Number);
    expect(minor > 5 || (minor === 5 && patch >= 23)).toBe(true);
    expect(postcss().version).toBe(version);
  });

  it.each(['absolute', 'relative'])('ignores an external %s map when from is unset', async (kind) => {
    const annotation = kind === 'absolute' ? outsideMap : relative(process.cwd(), outsideMap);
    const result = await processMap(annotation);
    expect(JSON.stringify(result.map.toJSON())).not.toContain(marker);
  });

  it('ignores a map outside the explicit CSS base directory', async () => {
    const result = await processMap('../outside.map', { from: input });
    expect(JSON.stringify(result.map.toJSON())).not.toContain(marker);
  });

  it('preserves ordinary styles and a valid map inside the CSS base directory', async () => {
    const result = await processMap('input.css.map', { from: input });
    const rules = result.root.nodes.filter((node) => node.type === 'rule');
    expect(rules).toHaveLength(1);
    expect(rules[0].toString()).toBe(style);
    expect(result.map.toJSON().sourcesContent).toContain(marker);
  });
});
