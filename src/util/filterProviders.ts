/**
 * Stub implementations of CLI provider-filter helpers.
 *
 * The original CLI commands were removed during the litmus fork; these lightweight
 * stubs keep util/config/load.ts compiling without pulling in any CLI deps.
 */

import type { ProviderOptions } from '../types/providers';

type ProviderConfigItem = string | ProviderOptions | Record<string, any>;

/**
 * Extract provider id and label from a provider config entry.
 * Handles strings, ProviderOptions ({ id, label, ... }), and
 * ProviderOptionsMap ({ 'openai:gpt-4': { config: ... } }).
 */
export function getProviderIdAndLabel(
  provider: ProviderConfigItem,
  _index: number,
): { id: string; label: string } {
  if (typeof provider === 'string') {
    return { id: provider, label: provider };
  }

  // ProviderOptions: has an explicit `id` field
  if ((provider as ProviderOptions).id) {
    const id = (provider as ProviderOptions).id!;
    const label = (provider as ProviderOptions).label ?? id;
    return { id, label };
  }

  // ProviderOptionsMap: single-key object like { 'openai:gpt-4': { config: ... } }
  const keys = Object.keys(provider);
  if (keys.length === 1) {
    const mapKey = keys[0];
    const nested = (provider as Record<string, any>)[mapKey];
    const id = nested?.id ?? mapKey;
    const label = nested?.label ?? id;
    return { id, label };
  }

  const label = (provider as ProviderOptions).label ?? `provider-${_index}`;
  return { id: `provider-${_index}`, label };
}

/**
 * Filter a list of provider configs by an optional glob/regex pattern.
 * If no filterPattern is provided, returns the list as-is.
 */
export function filterProviderConfigs<T>(configs: T[], filterPattern?: string): T[] {
  if (!filterPattern) {
    return configs;
  }

  const regex = new RegExp(filterPattern, 'i');
  return configs.filter((config) => {
    const { id, label } = getProviderIdAndLabel(config as ProviderConfigItem, 0);
    return regex.test(id) || regex.test(label);
  });
}
