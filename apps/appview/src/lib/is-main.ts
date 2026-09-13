import { pathToFileURL } from 'node:url'

/**
 * "Was this module run directly?"
 *
 * The usual `import.meta.url === \`file://${process.argv[1]}\`` is wrong for any path
 * containing a space or a parenthesis — `import.meta.url` percent-encodes them and the
 * naive template literal does not, so the guard silently never fires and the process exits
 * 0 having done nothing. This repository lives under
 * `.../iCloud Drive (Archive)/Documents/cursor projects/...`, which hits exactly that.
 */
export function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  return moduleUrl === pathToFileURL(entry).href
}
