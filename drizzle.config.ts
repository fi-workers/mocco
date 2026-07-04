import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/backend/db/schema.ts',
  out: './src/backend/db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://mocco:mocco@localhost:5432/mocco' },
});
