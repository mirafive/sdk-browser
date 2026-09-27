import type { Plugin } from "./types.ts"

export interface SiteSearchOptions {
  /** Query parameters that carry the search term. Default `q`, `s`, `search`, `query`. */
  parameters?: string[]
}

/** `$search` from the page URL and from `search(query)`. Mode "full" only, after consent. */
export const siteSearch = ({
  parameters = ["q", "s", "search", "query"]
}: SiteSearchOptions = {}): Plugin => ({
  name: "search",
  setup(core) {
    let pending: [query: string, url: string] | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    if (core.options.mode !== "full") {
      return core.warn('siteSearch() does nothing in mode "consentless"')
    }

    const search = (query: string, url = core.clean(location.href)): void =>
      core.send("$search", { query }, { url })

    // Live search rewrites the URL per keystroke; the term waits 1 s for the next one.
    const settle = (): void => {
      clearTimeout(timer)

      const settled = pending

      // Cleared first: search() queues an event, which may flush, which settles again.
      pending = undefined

      if (settled) {
        search(...settled)
      }
    }

    core.expose({ search })

    const onPageview = (href: string): void => {
      const url = new URL(href, location.href)
      const query = [url.searchParams, new URLSearchParams(core.state.hash ? url.hash.split("?")[1] : "")]
        .flatMap((found) => parameters.map((name) => found.get(name)))
        .find(Boolean)
      const page = core.clean(href)

      if (pending?.[1] !== page) {
        settle()
      }

      if (query) {
        clearTimeout(timer)
        pending = [query, page]
        timer = setTimeout(settle, 1e3)
      }
    }

    const offs = [core.on("flush", settle), core.on("pageview", onPageview)]

    // Added after the landing pageview (a loader fetching this plugin on consent): read that page too.
    if (core.state.page) {
      onPageview(location.href)
    }

    return () => {
      clearTimeout(timer)
      offs.forEach((off) => off())
    }
  }
})
