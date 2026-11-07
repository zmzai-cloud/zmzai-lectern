import { existsSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** A nested link back to the dependency root makes NFT directory globs recurse. */
export function checkDependencyLayout(root) {
  const modules = join(resolve(root), 'node_modules');
  const nested = join(modules, 'node_modules');
  if (existsSync(nested) && realpathSync(nested) === realpathSync(modules)) {
    throw new Error('Recursive node_modules/node_modules link detected. Remove only the nested link or reinstall dependencies before building.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { checkDependencyLayout(process.cwd()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
