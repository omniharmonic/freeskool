import { defineConfig } from 'drizzle-kit'
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://freeschool:freeschool@localhost:5434/freeschool',
  },
  // contrail owns its own tables; never let drizzle-kit try to drop them.
  tablesFilter: ['fs_*'],
})
