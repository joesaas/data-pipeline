/** @type {import('next').NextConfig} */
const nextConfig = {
  // Set NEXT_BASE_PATH (e.g. /data-ui) when the site is served under a path prefix.
  basePath: process.env.NEXT_BASE_PATH || undefined,
};
export default nextConfig;
