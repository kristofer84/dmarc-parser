import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 reads the datasource URL from here rather than from the schema. `process.env`
 * rather than Prisma's `env()` helper on purpose: `env()` throws when the variable is absent,
 * and the image runs `prisma generate` at build time, before DATABASE_URL exists.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
