/**
 * Stub implementation of CLI prompt-filter helper.
 *
 * The original CLI commands were removed during the litmus fork; this lightweight
 * stub keeps util/config/load.ts compiling without pulling in any CLI deps.
 */

import type { Prompt } from '../types/index';

/**
 * Filter parsed prompts by an optional regex/glob pattern.
 * If no filterPattern is provided, returns the list as-is.
 */
export function filterPrompts(prompts: Prompt[], filterPattern: string): Prompt[] {
  if (!filterPattern) {
    return prompts;
  }

  const regex = new RegExp(filterPattern, 'i');
  return prompts.filter((prompt) => {
    const raw = prompt.raw ?? '';
    const label = prompt.label ?? '';
    return regex.test(raw) || regex.test(label);
  });
}
