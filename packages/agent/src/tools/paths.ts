/**
 * Path confinement for the file tools.
 *
 * A tool argument is model-authored, so it is untrusted input. Every path is
 * resolved to its real location (following symlinks) and then checked to be
 * inside the configured workspace root, which is what stops `../../etc/passwd`
 * and a symlink planted inside the workspace from escaping it.
 */
import {readlink, realpath} from 'node:fs/promises';
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
 *
 * **A dangling symlink is followed, not re-appended.** `realpath` reports
 * ENOENT for a symlink whose target does not exist, exactly as it does for a
 * name that was never there — so appending the leaf unchecked treated
 * `<root>/link -> /outside/missing` as an ordinary new file inside the root.
 * `write_file` then followed the link and created the file outside the
 * workspace, and its own confirmation predicate returned false because `stat`
 * threw, so there was no approval card either. One escape, no gate, no warning.
 *
 * Reading the link first is what tells the two apart. The target is resolved
 * against the already-real parent — a relative link is relative to where the
 * link is, not to the process — and then resolved in turn, so a chain of
 * dangling links ends somewhere checkable rather than at the first hop.
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
    const resolvedParent = await realpathOrNearestAncestor(parent);

    /*
     * `readlink` fails with EINVAL for a name that is not a link and ENOENT for
     * one that is not there at all, and both mean the same thing here: an
     * ordinary new file under a parent that has already been resolved.
     */
    const link = await readlink(target).catch(() => undefined);
    if (link !== undefined) {
      const through = isAbsolute(link) ? link : resolve(resolvedParent, link);
      return await realpathOrNearestAncestor(through);
    }

    return join(resolvedParent, basename(target));
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as {code?: string}).code === 'ENOENT'
  );
}
