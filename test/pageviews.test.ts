import { describe, expect, it } from "vitest"

import { pageviews } from "../src/pageviews.ts"
import { define, events, mira, names, requests, setUrl, tick, w } from "./helpers.ts"

const pages = (): (string | undefined)[] => events().map((event) => event.page?.url)

describe("pageviews()", () => {
  it("sends the landing pageview a microtask after creation", async () => {
    const client = await mira({ plugins: [pageviews()] })

    await tick()
    await client.flush()

    expect(names()).toEqual(["$pageview"])
    expect(events()[0]?.page).toEqual({
      url: "https://shop.example/pricing?utm_source=news",
      title: "Pricing"
    })
  })

  it("skips the landing pageview with initial: false", async () => {
    const client = await mira({ plugins: [pageviews({ initial: false })] })

    await tick()
    history.replaceState({}, "", location.href)
    await tick()
    history.pushState({}, "", "/next")
    await tick()
    await client.flush()

    expect(pages()).toEqual(["https://shop.example/next"])
  })

  it("follows pushState, replaceState and popstate when the Navigation API is missing", async () => {
    const client = await mira({ plugins: [pageviews()] })

    await tick()
    history.pushState({}, "", "/a")
    await tick()
    history.replaceState({}, "", "/b?utm_campaign=x&q=1")
    await tick()
    setUrl("https://shop.example/c")
    window.dispatchEvent(new PopStateEvent("popstate"))
    await tick()
    await client.flush()

    expect(pages()).toEqual([
      "https://shop.example/pricing?utm_source=news",
      "https://shop.example/a",
      "https://shop.example/b?utm_campaign=x",
      "https://shop.example/c"
    ])
  })

  it("reads the title one macrotask after the navigation", async () => {
    const client = await mira({ plugins: [pageviews()] })

    await tick()
    history.pushState({}, "", "/checkout")
    document.title = "Kasse"
    await tick()
    await client.flush()

    expect(events()[1]?.page?.title).toBe("Kasse")
  })

  it("keeps both URLs when a router navigates twice in one tick", async () => {
    const client = await mira({ plugins: [pageviews()] })

    await tick()
    history.pushState({}, "", "/a")
    history.pushState({}, "", "/b")
    await tick()
    await client.flush()

    expect(pages().slice(1)).toEqual(["https://shop.example/a", "https://shop.example/b"])
  })

  it("sends the same path and query once", async () => {
    const client = await mira({ plugins: [pageviews()] })

    await tick()
    history.pushState({}, "", "/pricing?utm_source=news&secret=1")
    history.replaceState({ scroll: 1 }, "", location.href)
    history.pushState({}, "", "/pricing?utm_source=news&secret=1#faq")
    await tick()
    await client.flush()

    expect(names()).toEqual(["$pageview"])
  })

  it("uses the previous in-app URL as the referrer after the first view", async () => {
    define(document, "referrer", "https://www.google.com/")
    const client = await mira({ plugins: [pageviews()] })

    await tick()
    history.pushState({}, "", "/a")
    await tick()
    history.pushState({}, "", "/b")
    await tick()
    await client.flush()

    expect(events().map((event) => event.page?.referrer)).toEqual([
      "https://www.google.com/",
      "https://shop.example/pricing?utm_source=news",
      "https://shop.example/a"
    ])
  })

  it("uses navigatesuccess from the Navigation API and leaves history alone", async () => {
    const navigation = new EventTarget()
    const { pushState } = history

    ;(w as Record<string, unknown>)["navigation"] = navigation
    const client = await mira({ plugins: [pageviews()] })

    await tick()
    expect(history.pushState).toBe(pushState)
    history.pushState({}, "", "/a")
    await tick()
    expect(names()).toEqual([])
    navigation.dispatchEvent(new Event("navigatesuccess"))
    await tick()
    await client.flush()

    expect(pages()).toEqual(["https://shop.example/pricing?utm_source=news", "https://shop.example/a"])
  })

  it("counts hash changes and keeps the fragment in hash mode", async () => {
    setUrl("https://shop.example/#/pricing?utm_source=news&token=x")
    const client = await mira({ plugins: [pageviews({ hash: true })] })

    await tick()
    setUrl("https://shop.example/#/checkout")
    window.dispatchEvent(new HashChangeEvent("hashchange"))
    await tick()
    await client.flush()

    expect(pages()).toEqual([
      "https://shop.example/#/pricing?utm_source=news",
      "https://shop.example/#/checkout"
    ])
  })

  it("ignores hash changes outside hash mode", async () => {
    const client = await mira({ plugins: [pageviews()] })

    await tick()
    setUrl("https://shop.example/pricing?utm_source=news&secret=1#faq")
    window.dispatchEvent(new HashChangeEvent("hashchange"))
    await tick()
    await client.flush()

    expect(names()).toEqual(["$pageview"])
  })

  it("restores only its own history patch on destroy", async () => {
    const { pushState, replaceState } = history
    const client = await mira({ plugins: [pageviews()] })

    expect(history.pushState).not.toBe(pushState)
    client.destroy()
    expect(history.pushState).toBe(pushState)
    expect(history.replaceState).toBe(replaceState)

    const again = await mira({ plugins: [pageviews()] })
    const theirs = function (this: History, ...args: Parameters<History["pushState"]>): void {
      pushState.apply(this, args)
    }

    history.pushState = theirs
    again.destroy()
    expect(history.pushState).toBe(theirs)
    history.pushState = pushState
  })

  it("stops listening on destroy", async () => {
    const client = await mira({ plugins: [pageviews()] })

    await tick()
    client.destroy()
    window.dispatchEvent(new PopStateEvent("popstate"))
    await tick()

    expect(requests).toHaveLength(0)
  })

  it("waits for a prerendered page to be shown", async () => {
    define(document, "prerendering", true)
    const client = await mira({ plugins: [pageviews()] })

    await tick()
    await client.flush()
    expect(requests).toHaveLength(0)

    define(document, "prerendering", false)
    document.dispatchEvent(new Event("prerenderingchange"))
    await client.flush()

    expect(names()).toEqual(["$pageview"])
  })
})

describe("review fixes", () => {
  it("dedupes on the cleaned URL", async () => {
    const client = await mira({ plugins: [pageviews()] })

    await tick()
    history.pushState({}, "", "/pricing?utm_source=news&secret=2")
    await tick()
    history.pushState({}, "", "/pricing?utm_source=mail")
    await tick()
    await client.flush()

    expect(pages()).toEqual([
      "https://shop.example/pricing?utm_source=news",
      "https://shop.example/pricing?utm_source=mail"
    ])
  })
})
