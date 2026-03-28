import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TableRow } from '../../../../src/ui/components/table/TableRow';

import type { TableColumn, TableRowData } from '../../../../src/ui/components/table/types';

function createVarRow(varValue: unknown): TableRowData {
  return {
    index: 0,
    testIdx: 0,
    cells: [],
    originalRow: {
      description: 'row',
      outputs: [],
      vars: [varValue as string],
      test: { vars: {} } as any,
      testIdx: 0,
    },
  };
}

const columns: TableColumn[] = [
  {
    id: 'var-0',
    header: 'var',
    type: 'var',
    width: 10,
  },
];

describe('TableRow', () => {
  it('renders numeric var values instead of coercing them to empty strings', () => {
    const { lastFrame, unmount } = render(<TableRow rowData={createVarRow(0)} columns={columns} />);

    expect(lastFrame()).toContain('0');

    unmount();
  });

  it('renders boolean var values instead of coercing them to empty strings', () => {
    const { lastFrame, unmount } = render(
      <TableRow rowData={createVarRow(false)} columns={columns} />,
    );

    expect(lastFrame()).toContain('false');

    unmount();
  });
});
