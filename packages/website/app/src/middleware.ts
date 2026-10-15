import { createMiddleware } from "@solidjs/start/middleware"
import { LOCALE_HEADER, RETIRED_LOCALES, cookie, fromPathname, strip } from "~/lib/language"
import { normalizeReferralCode, referralCookie } from "~/lib/referral-invite"

export default createMiddleware({
  onRequest(event) {
    const url = new URL(event.request.url)
    const retired = url.pathname.split("/")[1] ?? ""
    if (RETIRED_LOCALES.includes(retired)) {
      url.pathname = `${retired === "zht" ? "/zh" : ""}${url.pathname.slice(retired.length + 1)}` || "/"
      return Response.redirect(url, 301)
    }
    const locale = fromPathname(url.pathname)
    if (locale) {
      url.pathname = strip(url.pathname)
      const request = new Request(url, event.request)
      request.headers.set(LOCALE_HEADER, locale)
      event.request = request
      event.response.headers.append("set-cookie", cookie(locale))
    }

    const referralCode = normalizeReferralCode(url.searchParams.get("ref"))
    if (referralCode) event.response.headers.append("set-cookie", referralCookie(referralCode))
  },
})
