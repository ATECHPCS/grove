/**
 * Convert a file emitted by an Agent into the task-relative path used by the
 * Review file tree. Agents commonly report absolute paths, while lazy tree
 * loading only accepts paths beneath the current Task.
 */
export function taskRelativeFilePath(
  targetPath: string,
  taskPath: string | null,
): string | null {
  const target = targetPath
    .replace(/^file:\/\//, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');

  if (!target.startsWith('/')) return target;
  if (!taskPath) return null;

  const root = taskPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (target === root) return '';
  if (target.startsWith(`${root}/`)) return target.slice(root.length + 1);
  return null;
}
