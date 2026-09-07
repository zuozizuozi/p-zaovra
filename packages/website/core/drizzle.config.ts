import { Resource } from "sst"
import { defineConfig } from "drizzle-kit"

export default defineConfig({
  out: "./migrations-postgres/",
  strict: true,
  schema: ["./src/**/*.sql.ts"],
  verbose: true,
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      `postgresql://${encodeURIComponent(Resource.Database.username)}:${encodeURIComponent(Resource.Database.password)}@${Resource.Database.host}:${Resource.Database.port}/${Resource.Database.database}?sslmode=require`,
  },
})
