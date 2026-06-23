/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  ...(process.env.EXPORT_MODE === 'true' && {
    output: 'export',
    images: { unoptimized: true },
  }),
};

export default nextConfig;
