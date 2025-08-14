/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },

   images: {
    unoptimized: true, // keep this if you don't want Next to optimize images
    remotePatterns: [
      // ── Supabase Storage (replace with your project ref) ──
      {
        protocol: "https",
        hostname: "<YOUR-PROJECT-REF>.supabase.co",
        pathname: "/storage/v1/object/public/**",
      },

      // ── IPFS Gateways ──
      { protocol: "https", hostname: "coral-perfect-wildebeest-997.mypinata.cloud", pathname: "/**" },
      { protocol: "https", hostname: "gateway.pinata.cloud", pathname: "/ipfs/**" },
      { protocol: "https", hostname: "cloudflare-ipfs.com", pathname: "/ipfs/**" },
      { protocol: "https", hostname: "ipfs.io", pathname: "/ipfs/**" },
        { protocol: 'https', hostname: 'emfkmevuacunuqqvijlf.supabase.co' },
    ],
  },
  async headers() {
    return [
      {
        // Apply these headers to all routes
        source: '/:path*',
        headers: [
          {
            // Prevent clickjacking attacks
            key: 'X-Frame-Options',
            value: 'SAMEORIGIN',
          },
          {
            // Prevent MIME type sniffing
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            // Enable XSS protection (legacy browsers)
            key: 'X-XSS-Protection',
            value: '1; mode=block',
          },
          {
            // Control referrer information
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            // Define allowed permissions for the page
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
        ],
      },
      {
        // Apply stricter CSP to API routes
        source: '/api/:path*',
        headers: [
          {
            // Content Security Policy for API routes
            key: 'Content-Security-Policy',
            value: "default-src 'self'; frame-ancestors 'none';",
          },
        ],
      },
    ]
  },
}

export default nextConfig
