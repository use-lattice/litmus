/**
 * Stub — CSV streaming for eval output.
 * The full server was removed; this keeps util/output.ts working.
 */

import type Eval from '../models/eval';

interface StreamCsvOptions {
  isRedteam?: boolean;
  write: (data: string) => Promise<void>;
}

export async function streamEvalCsv(evalRecord: Eval, options: StreamCsvOptions): Promise<void> {
  const table = await evalRecord.getTable();
  if (!table) {
    return;
  }

  const escapeCsv = (val: unknown): string => {
    const str = String(val ?? '');
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const headers = [
    ...table.head.vars,
    ...table.head.prompts.map((p: any) => `[${p.provider}] ${p.label}`),
  ];
  await options.write(headers.map(escapeCsv).join(',') + '\n');

  for (const row of table.body) {
    const outputTexts = row.outputs.map((o: any) => {
      const passText = o.pass ? 'PASS' : 'FAIL';
      return `[${passText}] ${o.text}`;
    });
    const cells = [...row.vars, ...outputTexts];
    await options.write(cells.map(escapeCsv).join(',') + '\n');
  }
}
