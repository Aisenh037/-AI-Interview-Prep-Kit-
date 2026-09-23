/**
 * Prove the batch entry point does not depend on a database or a web server.
 *
 * The brief requires `npm run evaluate` to run from a clean clone, and the
 * cleanest way to keep that true is to make it checkable rather than remembered.
 * This walks the import graph from the CLI entry point and fails if mongoose,
 * express or the mongodb driver appear anywhere in it.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const BANNED = ['mongoose', 'express', 'mongodb'];
const seen = new Set<string>();
const offenders: { file: string; imported: string }[] = [];

async function walk(file: string): Promise<void> {
  if (seen.has(file)) return;
  seen.add(file);

  let source: string;
  try {
    source = await readFile(file, 'utf8');
  } catch {
    return;
  }

  for (const match of source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) {
    const specifier = match[1];
    if (specifier === undefined) continue;

    if (BANNED.includes(specifier.split('/')[0] ?? '')) {
      offenders.push({ file, imported: specifier });
      continue;
    }
    if (!specifier.startsWith('.') && !specifier.startsWith('@kit/')) continue;

    const target = specifier.startsWith('@kit/')
      ? resolve('packages', specifier.replace('@kit/', ''), 'src/index.ts')
      : resolve(dirname(file), specifier.replace(/\.js$/, '.ts'));
    await walk(target);
  }
}

await walk(resolve('packages/cli/src/evaluate.ts'));

process.stdout.write(`walked ${seen.size} modules from the batch entry point\n`);
if (offenders.length > 0) {
  process.stdout.write('the batch path must not depend on a database or a web server:\n');
  for (const o of offenders) process.stdout.write(`  ${o.file} imports ${o.imported}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`no ${BANNED.join('/')} anywhere in the batch path\n`);
}
