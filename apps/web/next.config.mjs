/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Self-contained server bundle (own node_modules subset, no full monorepo
  // install needed at runtime) — what apps/web/Dockerfile's runtime stage
  // actually ships.
  output: "standalone",
};

export default nextConfig;
