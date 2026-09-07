/**
 * Application-wide constants and configuration
 */
export const config = {
  // Base URL
  baseUrl: "https://zaovra.com",

  // GitHub
  github: {
    repoUrl: "https://github.com/zuozizuozi/p-zaovra",
    starsFormatted: {
      compact: "160K",
      full: "160,000",
    },
  },

  // Social links
  social: {
    twitter: "https://x.com/zaovra",
    discord: "https://discord.gg/zaovra",
  },

  // Static stats (used on landing page)
  stats: {
    contributors: "900",
    commits: "13,000",
    monthlyUsers: "7.5M",
  },
} as const
