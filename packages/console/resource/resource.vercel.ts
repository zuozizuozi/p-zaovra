const structured = new Set(["Database", "ZEN_BLACK_PRICE", "ZEN_LITE_PRICE"])
const aliases: Record<string, string> = {
  Database: "DATABASE",
  HoneycombWebhookSecret: "HONEYCOMB_WEBHOOK_SECRET",
  UpstashRedisRestToken: "UPSTASH_REDIS_REST_TOKEN",
  UpstashRedisRestUrl: "UPSTASH_REDIS_REST_URL",
}

export const waitUntil = async (promise: Promise<unknown>) => {
  await promise
}

export const Resource = new Proxy(
  {},
  {
    get(_target, prop: string) {
      if (prop === "App") {
        return {
          stage: process.env.ZAOVRA_STAGE ?? (process.env.VERCEL_ENV === "production" ? "production" : "dev"),
        }
      }

      const linked = process.env[`SST_RESOURCE_${prop}`]
      if (linked) return JSON.parse(linked)

      const value = process.env[prop] ?? process.env[aliases[prop]]
      if (value === undefined) throw new Error(`Missing Vercel environment variable "${prop}"`)
      if (structured.has(prop)) return JSON.parse(value)
      return { value }
    },
  },
) as Record<string, unknown>
