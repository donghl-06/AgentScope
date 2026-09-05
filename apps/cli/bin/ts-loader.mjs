/* global URL */

import { access } from 'node:fs/promises';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
    const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
    try {
      await access(candidate);
      return nextResolve(candidate.href, context);
    } catch {
      // Keep Node's normal resolution error for packages and generated JavaScript files.
    }
  }
  return nextResolve(specifier, context);
}
