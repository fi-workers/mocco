import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './packages/backend/src/db/schema.ts',
  out: './packages/backend/src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://mocco:mocco@localhost:5432/mocco' },
});
