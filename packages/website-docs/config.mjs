const stage = process.env.SST_STAGE || "dev"

export default {
  url: stage === "production" ? "https://zaovra.com" : `https://${stage}.zaovra.com`,
  console: stage === "production" ? "https://zaovra.com/auth" : `https://${stage}.zaovra.com/auth`,
  email: "help@anoma.ly",
  socialCard: "https://social-cards.sst.dev",
  github: "https://github.com/zuozizuozi/p-zaovra",
  discord: "https://zaovra.com/discord",
  headerLinks: [
    { name: "app.header.home", url: "/" },
    { name: "app.header.docs", url: "/docs/" },
  ],
}
