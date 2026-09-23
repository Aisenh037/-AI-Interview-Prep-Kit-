import type { NextConfig } from 'next';

const config: NextConfig = {
  // @kit/shared ships TypeScript source rather than a build, so Next compiles it.
  transpilePackages: ['@kit/shared'],
  reactStrictMode: true,
  async rewrites() {
    // The browser only ever talks to this origin. The session cookie therefore
    // stays first-party and SameSite=Lax works everywhere — including Safari,
    // which blocks the SameSite=None cookie a direct cross-origin API would
    // need. This is edge proxying, not a serverless function, so no request
    // timeout applies to it.
    return [
      {
        source: '/api/backend/:path*',
        destination: `${process.env.API_ORIGIN ?? 'http://localhost:4000'}/api/:path*`,
      },
    ];
  },
};

export default config;
