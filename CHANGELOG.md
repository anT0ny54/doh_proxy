# Changelog

## [2.11.0] - 2026-11-06

### Changed
- Removed the Tailwind CSS 4 and `@tailwindcss/postcss` development
  dependencies and deleted `postcss.config.mjs`. The homepage keeps its
  existing markup class names through a small dependency-free stylesheet,
  reducing frontend build tooling and lockfile packages without changing the
  page structure or visual design.
- The Docker builder no longer copies `postcss.config.mjs`.
- Bumped the project version to 2.11.0.

### Tests
- Not run in this environment: the available Node.js version was 20.20.2,
  while the project requires Node.js 22 or newer, and the locked dependency
  tree was not installed. Run `npm ci`, `npm test`, `npm run lint`,
  `npm run typecheck`, `npm run build`, `npm run test:integration`, and the
  Docker smoke test on Node.js 22 before publishing.

