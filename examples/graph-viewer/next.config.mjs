/** @type {import('next').NextConfig} */
const nextConfig = {
  // @mnemo-ai/core ships ESM + types; transpiling it keeps the client-safe
  // `@mnemo-ai/core/graph` entry resolvable from both server and client
  // components without prebundling surprises.
  transpilePackages: ["@mnemo-ai/core"],
};

export default nextConfig;
