// MNEMO_GRPC_PORT: the optional cleartext HTTP/2 (h2c) listener for the gRPC
// service. The main listener is node:http (HTTP/1.1), which carries Connect and
// gRPC-Web but not a bidirectional stream (Session, FederationSync) nor the gRPC
// protocol itself; this second listener serves only the Connect handler over
// HTTP/2. Pure function over an env bag so it is unit-testable.

/** The h2c port, or undefined when MNEMO_GRPC_PORT is unset or empty; throws on a bad value. */
export function readGrpcPort(
  env: Record<string, string | undefined>,
  httpPort: number
): number | undefined {
  const raw = env.MNEMO_GRPC_PORT?.trim();
  if (!raw) return undefined;
  const port = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(port >= 1 && port <= 65535)) {
    throw new Error(`MNEMO_GRPC_PORT must be a TCP port between 1 and 65535, got "${raw}"`);
  }
  if (port === httpPort) {
    throw new Error(
      `MNEMO_GRPC_PORT must differ from PORT (${httpPort}): HTTP/1.1 and h2c need separate listeners`
    );
  }
  return port;
}

/**
 * The IP allowlist reads cf-connecting-ip / x-forwarded-for / x-real-ip (see
 * grpc.ts). The h2c port may be exposed without the proxy that rewrites them in
 * front of PORT, so they count only on a connection from trustedProxyIp; on any
 * other they are replaced by the socket's own address.
 */
export function pinClientIpHeaders(
  req: {
    headers: Record<string, string | string[] | undefined>;
    socket?: { remoteAddress?: string } | null;
  },
  trustedProxyIp: string | undefined
): void {
  const remote = req.socket?.remoteAddress?.replace(/^::ffff:/, "") ?? "";
  if (trustedProxyIp && remote === trustedProxyIp) return;
  delete req.headers["cf-connecting-ip"];
  delete req.headers["x-real-ip"];
  req.headers["x-forwarded-for"] = remote;
}
