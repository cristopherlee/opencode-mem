type RuntimeWithGarbageCollector = typeof globalThis & {
  Bun?: {
    gc?: (force?: boolean) => void;
  };
  gc?: () => void;
};

const GC_PASSES = 3;

/**
 * libsql 0.5.x leaves prepared-statement handles alive until garbage collection.
 * Collect them before Windows file swaps/removals that require exclusive access.
 *
 * Upstream: https://github.com/tursodatabase/libsql-js/issues/228
 */
export async function collectReleasedSqliteHandles(): Promise<void> {
  const runtime = globalThis as RuntimeWithGarbageCollector;
  const bunGc = runtime.Bun?.gc;
  const globalGc = runtime.gc;

  if (!bunGc && !globalGc) return;

  for (let pass = 0; pass < GC_PASSES; pass += 1) {
    bunGc?.(true);
    globalGc?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}
