/**
 * Stub implementation of the CLI `eval` command entry-point.
 *
 * The original CLI was removed during the litmus fork.  This module provides
 * a minimal `doEval` function that keeps `redteam/shared.ts` compiling
 * by wiring together the existing config-loading and evaluation pipeline.
 */

import cliState from './cliState';
import { evaluate } from './evaluator';
import logger from './logger';
import Eval from './models/eval';
import { readProviderPromptMap } from './prompts/index';
import { resolveConfigs } from './util/config/load';
import { writeMultipleOutputs, writeOutput } from './util/output';

import type { CommandLineOptions, EvaluateOptions, TestSuite, UnifiedConfig } from './types/index';

interface DoEvalExtraOptions {
  showProgressBar?: boolean;
  abortSignal?: AbortSignal;
  progressCallback?: EvaluateOptions['progressCallback'];
}

/**
 * Run an evaluation from config files, matching the original CLI `eval` command
 * contract expected by `redteam/shared.ts`.
 */
export async function doEval(
  cmdObj: Partial<CommandLineOptions>,
  defaultConfig: Partial<UnifiedConfig>,
  _configPath?: string,
  extraOptions?: DoEvalExtraOptions,
): Promise<Eval | undefined> {
  const { testSuite, config, basePath } = await resolveConfigs(cmdObj, defaultConfig);

  // Set cliState basePath for provider resolution
  if (basePath) {
    cliState.basePath = basePath;
  }

  const providerPromptMap = readProviderPromptMap(
    { providers: config.providers },
    testSuite.prompts,
  );

  const evalRecord = cmdObj.write
    ? await Eval.create({ ...config, prompts: testSuite.prompts }, testSuite.prompts)
    : new Eval({ ...config, prompts: testSuite.prompts });

  const defaultTestObj =
    typeof testSuite.defaultTest === 'object' ? testSuite.defaultTest : undefined;

  const evalOptions: EvaluateOptions = {
    maxConcurrency: cmdObj.maxConcurrency ?? defaultTestObj?.options?.maxConcurrency,
    showProgressBar: extraOptions?.showProgressBar,
    abortSignal: extraOptions?.abortSignal,
    progressCallback: extraOptions?.progressCallback,
    eventSource: 'library',
    isRedteam: Boolean(config.redteam),
    repeat: cmdObj.repeat,
  };

  if (cmdObj.cache === false) {
    const cache = await import('./cache');
    cache.disableCache();
  }

  const result = await evaluate(
    {
      ...testSuite,
      providerPromptMap,
    },
    evalRecord,
    evalOptions,
  );

  // Write output files if requested
  if (cmdObj.output) {
    const outputs = Array.isArray(cmdObj.output) ? cmdObj.output : [cmdObj.output];
    if (outputs.length === 1) {
      await writeOutput(outputs[0], evalRecord, null);
    } else {
      await writeMultipleOutputs(outputs, evalRecord, null);
    }
  }

  return result;
}
