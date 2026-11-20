import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  reactStrictMode: true,
  trailingSlash: true,
  poweredByHeader: false,
}

export default nextConfig
