import { resolve } from 'node:path';

/** Project worktrees are user runtime data, never assets bundled by NFT.
 * Keep the rest/spread boundary: partially evaluating resolve(root, literal, id)
 * makes NFT glob every dependency directory for that literal during compilation.
 * Runtime normalization and existing ownership/path checks remain unchanged.
 */
export function runtimeWorkspacePath(...parts: string[]): string {
  return resolve(...parts);
}
