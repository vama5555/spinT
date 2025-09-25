import withPWA from 'next-pwa';

const isDev = process.env.NODE_ENV === 'development';

/**
 * PWA configuration:
 * - Generates service worker files into /public
 * - Registers automatically (no custom code needed)
 * - skipWaiting activates the new SW immediately when a new version is deployed
 * - Disabled in `next dev` to avoid cache headaches during development
 */
const withPWAFn = withPWA({
  dest: 'public',
  register: true,
  skipWaiting: true,
  disable: isDev,
});

/** Next.js config */
const nextConfig = {
  reactStrictMode: true,
};

export default withPWAFn(nextConfig);
