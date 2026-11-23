import path from "node:path";

import type { NextConfig } from "next";

import { version } from "./package.json";

/**
 * The Hono API server. In dev the dashboard proxies /dashboard/auth/* and
 * /dashboard/bootstrap* to it so the browser only ever talks same-origin —
 * the mnemo_dash_token cookie (Path=/dashboard, SameSite=Lax) works without
 * any cross-origin handling. In production an edge proxy (nginx) plays this
 * role instead. Spec: openspec/dashboard/spec.md §1.1.
 */
const MNEMO_SERVER_URL = process.env.MNEMO_SERVER_URL ?? "http://localhost:3939";

/**
 * Content-Security-Policy for every page (APP-057). Next's own guide, "Without Nonces":
 * its bootstrap streams inline <script> tags, so script-src needs 'unsafe-inline' unless
 * proxy.ts mints a per-request nonce (the upgrade path: Next reads the nonce from this
 * header). 'unsafe-eval' only in dev, for React's dev tooling. Inline style attributes
 * (`style={{ "--i": 1 }}`) and next/font's injected styles need style-src 'unsafe-inline'.
 * blob: workers and images cover the graph's three.js / canvas exports. The browser only
 * talks to this origin: the API is reached through the rewrites below.
 */
const isDev = process.env.NODE_ENV !== "production";
const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  // Browsers ignore HSTS on plain http, so it is safe to send always; it binds once served
  // over https. No includeSubDomains: the dashboard does not own its parent domain.
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
];

const nextConfig: NextConfig = {
  /**
   * Salida standalone: server.js autocontenido + node_modules mínimo, para
   * correr el dashboard como contenedor propio. Vercel la ignora, así que no
   * afecta a quien lo despliegue ahí.
   *
   * OJO con MNEMO_SERVER_URL: los `rewrites()` se resuelven en BUILD TIME y
   * quedan horneados en .next/routes-manifest.json. Setearla sólo en runtime
   * no tiene efecto — el contenedor termina proxeando /dashboard/auth/* a
   * localhost:3939 dentro de sí mismo y el login falla sin error claro.
   * Pasarla como build arg.
   */
  output: "standalone",
  /**
   * Monorepo pnpm: sin esto el file-tracing arranca desde packages/dashboard y
   * no sigue los symlinks del store, así que la salida standalone queda sin
   * dependencias que SÍ se necesitan en runtime.
   *
   * `process.cwd()` y no `__dirname`: Next transpila este archivo, y
   * reconstruir __dirname con import.meta.url rompe el load con
   * "exports is not defined in ES module scope". El build corre desde
   * packages/dashboard, así que ../.. es la raíz del monorepo.
   */
  outputFileTracingRoot: path.join(process.cwd(), "../.."),
  /**
   * @swc/helpers no lo detecta el trace: Next lo carga por require-hook
   * dinámico, no por un import estático, así que no entra en el grafo. Sin
   * esto el contenedor arranca y muere con
   * `Cannot find module '@swc/helpers/esm/_interop_require_default.js'`.
   */
  outputFileTracingIncludes: {
    "/**/*": ["../../node_modules/.pnpm/@swc+helpers@*/node_modules/@swc/helpers/**/*"],
  },
  basePath: "/dashboard",
  /** The dev-only Next.js badge sits bottom-left by default, over the sidebar footer. */
  devIndicators: { position: "bottom-right" },
  /** No `X-Powered-By: Next.js`: nothing gains from knowing the framework (APP-057). */
  poweredByHeader: false,
  /** Shown on the entry pages. Only the version: the whole package.json would ship its dependencies. */
  env: { NEXT_PUBLIC_DASHBOARD_VERSION: version },
  /**
   * Every route gets the security headers. The link page carries a single-use token in its
   * URL: never send it on as a Referer, and never cache the page. It comes last, so its
   * Referrer-Policy wins over the global one (Next: the last matching key overrides).
   */
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      {
        source: "/link/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
  async rewrites() {
    return {
      // beforeFiles: these paths must win over any future app route.
      // With basePath set, `source` is automatically prefixed with /dashboard.
      beforeFiles: [
        {
          source: "/auth/:path*",
          destination: `${MNEMO_SERVER_URL}/dashboard/auth/:path*`,
        },
        {
          source: "/api/:path*",
          destination: `${MNEMO_SERVER_URL}/dashboard/api/:path*`,
        },
        {
          source: "/bootstrap",
          destination: `${MNEMO_SERVER_URL}/dashboard/bootstrap`,
        },
        {
          source: "/bootstrap/:path*",
          destination: `${MNEMO_SERVER_URL}/dashboard/bootstrap/:path*`,
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
