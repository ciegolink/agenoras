// CalDAV/CardDAV (tsdav) use the global fetch. Servers close idle keep-alive connections without notice,
// so the next request on such a socket fails with "fetch failed". Read requests are retried once.

const READ = new Set(['GET', 'HEAD', 'OPTIONS', 'PROPFIND', 'REPORT']);
const original = globalThis.fetch;

globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  try {
    return await original(input, init);
  } catch (err) {
    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    // only network failures (TypeError "fetch failed"), not aborts
    if (!(err instanceof TypeError) || init?.signal?.aborted || !READ.has(method)) throw err;
    await new Promise((r) => setTimeout(r, 400));
    return original(input, init);
  }
};

// "fetch failed" hides the reason in err.cause: turn it into something readable
export function netReason(err: unknown): string | null {
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  if (!cause || (err as Error)?.message !== 'fetch failed') return null;
  return cause.code ?? cause.message ?? null;
}
