/**
 * Path confinement for the file tools.
 *
 * A tool argument is model-authored, so it is untrusted input. Every path is
 * resolved to its real location (following symlinks) and then checked to be
 * inside the configured workspace root, which is what stops `../../etc/passwd`
 * and a symlink planted inside the workspace from escaping it.
 */
import {realpath} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';

export class PathOutsideWorkspaceError extends Error {
  constructor(candidate: string, root: string) {
    super(
      `Path "${candidate}" is outside the workspace root "${root}". ` +
        'Only files inside the workspace can be accessed.',
    );
    this.name = 'PathOutsideWorkspaceError';
  }
}

export async function resolveInsideWorkspace(
  root: string,
  candidate: string,
): Promise<string> {
  const absoluteRoot = await realpathOrNearestAncestor(resolve(root));
  const requested = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(absoluteRoot, candidate);
  const resolved = await realpathOrNearestAncestor(requested);

  if (resolved === absoluteRoot) {
    return resolved;
  }
  const rel = relative(absoluteRoot, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new PathOutsideWorkspaceError(candidate, absoluteRoot);
  }
  return resolved;
}

/**
 * Real path of `target`, or of its nearest existing ancestor with the
 * non-existent tail re-appended. A path that does not exist yet still has to be
 * checkable, and resolving only the ancestor is what keeps a symlinked parent
 * from hiding an escape.
 */
async function realpathOrNearestAncestor(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
    const parent = dirname(target);
    if (parent === target) {
      return target;
    }
    return join(await realpathOrNearestAncestor(parent), basename(target));
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as {code?: string}).code === 'ENOENT'
  );
}
