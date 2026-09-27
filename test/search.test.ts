import { describe, expect, it } from "vitest"

import { identity } from "../src/identity.ts"
import { pageviews } from "../src/pageviews.ts"
import { siteSearch } from "../src/search.ts"
import type { SiteSearchOptions } from "../src/search.ts"
import { events, mira, requests, setUrl, tick, w, warnings } from "./helpers.ts"

const searches = (): unknown[] =>
  events()
    .filter((event) => event.name === "$search")
    .map((event) => [event.properties?.["query"], event.page?.url])

const consented = async (options?: SiteSearchOptions) => {
  w.__mirafive_consent = { statistics: true }
  return mira({ mode: "full", plugins: [pageviews(), identity(), siteSearch(options)] })
}

describe("siteSearch()", () => {
  it("reads the term before the URL is cleaned and sends it after 1 s", async () => {
    setUrl("https://shop.example/search?q=red+shoes&utm_source=news")
    const client = await consented()

    await tick(999)
    expect(searches()).toEqual([])
    await tick(1)
    await client.flush()

    expect(searches()).toEqual([["red shoes", "https://shop.example/search?utm_source=news"]])
    expect(events()[0]?.page?.url).toBe("https://shop.example/search?utm_source=news")
  })

  it("sends one $search for a live search that rewrites the URL per keystroke", async () => {
    setUrl("https://shop.example/search?q=r")
    const client = await consented()

    await tick(200)
    history.replaceState({}, "", "/search?q=re")
    await tick(200)
    history.replaceState({}, "", "/search?q=red")
    await tick(1000)
    await client.flush()

    expect(searches()).toEqual([["red", "https://shop.example/search"]])
  })

  it("sends a pending term when the visitor moves on", async () => {
    setUrl("https://shop.example/search?q=boots")
    const client = await consented()

    await tick(10)
    history.pushState({}, "", "/product/1")
    await tick(10)
    await client.flush()

    expect(searches()).toEqual([["boots", "https://shop.example/search"]])
  })

  it("sends a pending term with the page-hide flush", async () => {
    setUrl("https://shop.example/search?s=boots")
    await consented()

    await tick(10)
    window.dispatchEvent(new Event("pagehide"))

    expect(requests.map((request) => request.via)).toEqual(["beacon"])
    expect(searches()).toEqual([["boots", "https://shop.example/search"]])
  })

  it("takes custom parameters", async () => {
    setUrl("https://shop.example/find?term=hats&q=ignored")
    const client = await consented({ parameters: ["term"] })

    await tick(1000)
    await client.flush()

    expect(searches()).toEqual([["hats", "https://shop.example/find"]])
  })

  it("reads the query inside the fragment in hash mode", async () => {
    setUrl("https://shop.example/#/search?query=hats")
    w.__mirafive_consent = { statistics: true }
    const client = await mira({
      mode: "full",
      plugins: [pageviews({ hash: true }), identity(), siteSearch()]
    })

    await tick(1000)
    await client.flush()

    expect(searches()).toEqual([["hats", "https://shop.example/#/search"]])
  })

  it("reads the current page when added after the landing pageview", async () => {
    setUrl("https://shop.example/search?q=boots")
    const client = await mira({ mode: "full", plugins: [pageviews(), identity()] })

    await tick()
    client.consent(true)
    client.use(siteSearch())
    await tick(1000)
    await client.flush()

    expect(searches()).toEqual([["boots", "https://shop.example/search"]])
  })

  it("search(query) sends $search at once", async () => {
    const client = await consented()

    client.search("gift card")
    await client.flush()

    expect(searches()).toEqual([["gift card", "https://shop.example/pricing?utm_source=news"]])
  })

  it("sends nothing before consent", async () => {
    setUrl("https://shop.example/search?q=boots")
    const client = await mira({ mode: "full", plugins: [pageviews(), identity(), siteSearch()] })

    await tick(1000)
    client.search("x")
    await client.flush()

    expect(requests).toHaveLength(0)
  })

  it('does nothing in mode "consentless" and warns in development', async () => {
    setUrl("http://localhost:3000/search?q=boots")
    const client = await mira({ plugins: [pageviews(), siteSearch()], trackLocalhost: true })

    await tick(1000)
    client.search("x")
    await client.flush()

    expect(searches()).toEqual([])
    expect(warnings()).toContain('[mirafive] siteSearch() does nothing in mode "consentless"')
  })
})
