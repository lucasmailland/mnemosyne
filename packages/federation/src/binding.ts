export interface FederationBindingInput {
  keyType: string | undefined;
  /** The peer's presented key/cert. Never proof on its own: the service JWT is. */
  clientCert: Uint8Array | undefined;
  /**
   * The TLS version the server KNOWS was negotiated: from its own TLS socket,
   * or from a TLS-terminating proxy the operator trusts. Never a client claim.
   */
  tlsProtocol: string | undefined;
  /**
   * Dev/test only (MNEMO_FED_INSECURE_TRANSPORT=true, refused in production):
   * accept a request that did not arrive over TLS. Every other check still runs.
   */
  allowInsecureTransport?: boolean;
}

export type FederationBindingResult = { ok: true } | { ok: false; reason: string };

export function assertFederationBinding(input: FederationBindingInput): FederationBindingResult {
  if (input.keyType !== "mk_fed_") {
    return { ok: false, reason: "federation requires an mk_fed_ key" };
  }
  if (!input.clientCert || input.clientCert.length === 0) {
    return { ok: false, reason: "federation requires mTLS (no client certificate presented)" };
  }
  if (input.tlsProtocol === undefined && input.allowInsecureTransport) return { ok: true };
  if (input.tlsProtocol !== "TLSv1.3") {
    return {
      ok: false,
      reason: `TLS 1.3 is mandatory for federation (got ${input.tlsProtocol ?? "none"})`,
    };
  }
  return { ok: true };
}
