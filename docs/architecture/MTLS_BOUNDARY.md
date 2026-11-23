# mTLS Boundary Architecture

Mnemosyne does not terminate mTLS at the application layer. Instead, it relies on
a trusted TLS-terminating proxy (e.g. nginx, Fly.io's anycast network, or a cloud
load balancer) to handle the TLS handshake and pass the negotiated TLS version
and the verified client certificate in the `x-mnemo-tls-protocol` and
`x-mnemo-client-cert` HTTP headers.

## Why Not In-Process TLS?

The server uses `node:http` (`createServer`) without TLS options. This is an
intentional design choice:

- TLS termination is better handled by hardened, purpose-built proxies that receive
  security patches independently of application code.
- It allows zero-downtime certificate rotation at the proxy layer.
- It separates concerns: the proxy authenticates transport security; the application
  authenticates the identity encoded in the certificate.

## What the Server Takes From the Proxy

The federation peer gate (`packages/server/src/federation/authenticateFederationRequest.ts`,
used by `/memory/federation/items` and `/memory/federation/resolve`) reads the
proxy headers only when `MNEMO_FED_TLS_PROXY=true`:

- `x-mnemo-tls-protocol`: must be `TLSv1.3` (nginx: `$ssl_protocol`).
- `x-mnemo-client-cert`: the verified client certificate, as nginx's
  `$ssl_client_escaped_cert` (URL-encoded PEM) or as base64url DER. The
  certificate's public key must be the peer's pinned Ed25519 federation key, so
  the peer's client certificate is issued for that key.

Neither header is proof on its own: the request must also carry the `mk_fed_`
key and a service JWT signed with the pinned key (see
`packages/federation/README.md`).

## Trusted-Proxy Boundary

With `MNEMO_TRUSTED_PROXY_IP` set, both headers count only on connections whose
**socket address** is that IP. A client that reaches the server directly and
writes the headers itself gets no TLS version and no certificate, and the gate
refuses it. `X-Forwarded-For` is never consulted: the client writes it.

Without `MNEMO_TRUSTED_PROXY_IP`, the headers are trusted from any connection and
the server logs a warning at boot. That is only safe when nothing but the proxy
can reach the server.

## Environment Variables

| Variable                 | Required    | Description                                                                                       |
| ------------------------ | ----------- | ------------------------------------------------------------------------------------------------- |
| `MNEMO_FED_TLS_PROXY`    | Yes         | `true`: take the TLS version and client certificate from the proxy headers.                       |
| `MNEMO_TRUSTED_PROXY_IP` | Recommended | Address the proxy connects from (as the server's socket sees it). The headers count only from it. |

The pulling side (see "Pulling Through a Peer's Proxy" below):

| Variable                     | Required                      | Description                                                                  |
| ---------------------------- | ----------------------------- | ---------------------------------------------------------------------------- |
| `MNEMO_FED_CLIENT_CERT_FILE` | When the peer requires a cert | PEM client certificate presented on pulls, issued for our federation key.    |
| `MNEMO_FED_CLIENT_KEY_FILE`  | With the certificate          | PEM private key of that certificate.                                         |
| `MNEMO_FED_CA_FILE`          | No                            | PEM CA that verifies the peer's TLS certificate instead of the system roots. |

## Deployment Requirements

1. **The TLS terminator MUST overwrite `x-mnemo-tls-protocol` and
   `x-mnemo-client-cert` on every request.** nginx's `proxy_set_header` replaces
   any copy the client sent.

2. **The Mnemosyne server SHOULD NOT be directly reachable by peers.** Bind it to
   a private address and set `MNEMO_TRUSTED_PROXY_IP` so a direct connection
   cannot claim TLS or a certificate.

3. **Only TLS 1.3.** The server refuses anything else even if the proxy lets it
   through, but the proxy should not negotiate it in the first place.

## Example nginx Configuration

Tested in `packages/server/src/__tests__/integration/federation-tls-proxy.integration.test.ts`
against `nginx:1.27.5`.

```nginx
server {
    listen 443 ssl;
    ssl_protocols          TLSv1.3;
    ssl_certificate        /etc/ssl/server.crt;
    ssl_certificate_key    /etc/ssl/server.key;
    # The CA that issues your peers' client certificates.
    ssl_client_certificate /etc/ssl/peers-ca.crt;
    ssl_verify_client      on;

    location / {
        proxy_pass http://10.0.0.3:3000;
        # Both replace whatever the client sent.
        proxy_set_header X-Mnemo-Tls-Protocol $ssl_protocol;
        proxy_set_header X-Mnemo-Client-Cert  $ssl_client_escaped_cert;
    }
}
```

On the Mnemosyne server: `MNEMO_FED_TLS_PROXY=true` and
`MNEMO_TRUSTED_PROXY_IP=10.0.0.2` (the nginx host's private address).

A peer's client certificate carries its federation key. With the key in
`fed.key` (`openssl genpkey -algorithm ed25519`), the CA signs a request for it:

```sh
openssl req -new -key fed.key -subj /CN=larkspur.example -out fed.csr
openssl x509 -req -in fed.csr -CA peers-ca.crt -CAkey peers-ca.key -days 365 -out fed.crt
```

## Pulling Through a Peer's Proxy

The other half: this server pulling (`POST /memory/federation/sync`) from a peer
whose nginx has `ssl_verify_client on`. Without a client certificate nginx answers
`400` and the sync job ends `failed`. Give the server its certificate and key as
files (the `fed.crt` and `fed.key` above):

```sh
MNEMO_FED_CLIENT_CERT_FILE=/etc/mnemo/fed.crt
MNEMO_FED_CLIENT_KEY_FILE=/etc/mnemo/fed.key
# Only when the peer's server certificate is not from a public CA:
MNEMO_FED_CA_FILE=/etc/mnemo/peer-server-ca.crt
```

Pulls from `https://` peers then present that certificate. Set both certificate
variables or neither; a file that cannot be read, or a certificate and key that
do not match, stops the server at boot. Without these variables pulls go out
as before, with no client certificate. The same integration test boots the
peer as a second server and runs its sync through nginx both ways.

## References

- `packages/server/src/federation/authenticateFederationRequest.ts`: the peer gate
- `packages/server/src/boot/federation.ts`: reads `MNEMO_FED_TLS_PROXY` and `MNEMO_TRUSTED_PROXY_IP`
- `packages/server/src/federation/federationIdentity.ts` (`pullTlsFromEnv`): reads the `MNEMO_FED_*_FILE` variables
- `docs/deploy/SERVICES.md`: full environment variable reference
