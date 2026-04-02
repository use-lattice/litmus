/**
 * Stub implementation of CLI test-filter helper.
 *
 * The original CLI commands were removed during the litmus fork; this lightweight
 * stub keeps util/config/load.ts compiling without pulling in any CLI deps.
 */

import type { TestCase } from '../types/index';

interface FilterOptions {
  firstN?: number;
  pattern?: string;
  failing?: string;
  sample?: number;
}

interface ScenarioLike {
  tests?: TestCase[];
  [key: string]: unknown;
}

/**
 * Filter tests within a scenario by the provided options.
 * Returns the (possibly filtered) test list.
 */
export async function filterTests(
  scenario: ScenarioLike,
  options: FilterOptions,
): Promise<TestCase[]> {
  let tests = scenario.tests ?? [];

  if (options.pattern) {
    const regex = new RegExp(options.pattern, 'i');
    tests = tests.filter((test) => {
      const description = test.description ?? '';
      const vars = JSON.stringify(test.vars ?? {});
      return regex.test(description) || regex.test(vars);
    });
  }

  if (options.firstN != null && options.firstN > 0) {
    tests = tests.slice(0, options.firstN);
  }

  if (options.sample != null && options.sample > 0 && options.sample < tests.length) {
    // Simple random sample
    const shuffled = [...tests].sort(() => Math.random() - 0.5);
    tests = shuffled.slice(0, options.sample);
  }

  return tests;
}
