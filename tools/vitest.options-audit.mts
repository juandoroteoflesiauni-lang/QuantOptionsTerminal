import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tools/ggal_options.audit.ts'] },
});
