/**
 * Stub — the OTLP HTTP receiver was removed during the litmus fork.
 * The evaluator tracing module dynamically imports these functions,
 * so providing no-op stubs keeps the import from failing at runtime.
 */

export async function startOTLPReceiver(
  _port: number,
  _host: string,
  _acceptFormats?: string[],
): Promise<void> {
  throw new Error('OTLP receiver is not available in the litmus library build.');
}

export async function stopOTLPReceiver(): Promise<void> {
  // no-op
}
