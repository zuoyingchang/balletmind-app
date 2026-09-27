// Same defaults the Tailwind Play CDN used (no custom theme, no plugins), scanned over the shipped pages.
module.exports = {
  content: ['../public/*.html', '../public/js/**/*.js'],
  theme: { extend: {} },
  plugins: [],
};
