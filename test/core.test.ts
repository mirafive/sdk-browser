import { describe, expect, expectTypeOf, it, vi } from "vitest"

import { identity } from "../src/identity.ts"
import type { Mira, MiraCore, Plugin } from "../src/index.ts"
import { pageviews } from "../src/pageviews.ts"
import {
  HOST,
  KEY,
  batches,
  beacon,
  define,
  events,
  factory,
  fetchMock,
  json,
  load,
  mira,
  names,
  requests,
  route,
  setUrl,
  tick,
  w,
  warnings
} from "./helpers.ts"

describe("transport", () => {
  it("posts a text/plain batch to /v1/batch/{key} without credentials", async () => {
    const client = await mira()

    client.track("signup", { plan: "pro" })
    await client.flush()

    expect(requests).toHaveLength(1)
    const [request] = requests

    expect(request?.url).toBe(`${HOST}/v1/batch/${KEY}`)
    expect(request?.init).toMatchObject({ method: "POST", credentials: "omit", keepalive: false })
    expect(request?.init?.headers).toBeUndefined()
    expect(typeof request?.init?.body).toBe("string")
    expect(
      new Request("https://x.example", { method: "POST", body: request?.body ?? "" }).headers.get(
        "content-type"
      )
    ).toBe("text/plain;charset=UTF-8")
    expect(batches()).toEqual([
      {
        v: 1,
        batch: expect.stringMatching(/^[0-9a-f-]{36}$/),
        mode: "consentless",
        sentAt: 1_727_430_000_000,
        context: { sdk: "mirafive-browser/1.0.0" },
        events: [
          {
            name: "signup",
            time: 1_727_430_000_000,
            page: { url: "https://shop.example/pricing?utm_source=news" },
            properties: { plan: "pro" }
          }
        ]
      }
    ])
    expect(events()[0]).not.toHaveProperty("id")
  })

  it("uses a custom host without its trailing slash", async () => {
    const client = await mira({ host: "https://collect.shop.example/" })

    client.track("a")
    await client.flush()

    expect(requests[0]?.url).toBe(`https://collect.shop.example/v1/batch/${KEY}`)
  })

  it("flushes at flushAt events", async () => {
    const client = await mira({ flushAt: 3 })

    client.track("a")
    client.track("b")
    expect(requests).toHaveLength(0)
    client.track("c")
    await tick()

    expect(batches().map((batch) => batch.events.length)).toEqual([3])
  })

  it("flushes flushAfterMs after the first queued event", async () => {
    const client = await mira({ flushAfterMs: 2000 })

    client.track("a")
    await tick(1000)
    client.track("b")
    await tick(999)
    expect(requests).toHaveLength(0)
    await tick(1)

    expect(names()).toEqual(["a", "b"])
  })

  it("keeps each batch under ~48 KB", async () => {
    const client = await mira({ flushAt: 1000 })
    const text = "x".repeat(20_000)

    client.track("a", { text })
    client.track("b", { text })
    client.track("c", { text })
    await client.flush()

    expect(batches().map((batch) => batch.events.map((event) => event.name))).toEqual([["a", "b"], ["c"]])
    expect(requests.every((request) => new Blob([request.body]).size < 60_000)).toBe(true)
  })

  it("gives every batch a new id", async () => {
    const client = await mira()

    client.track("a")
    await client.flush()
    client.track("b")
    await client.flush()

    const [first, second] = batches()

    expect(first?.batch).not.toBe(second?.batch)
  })

  it("mints batch ids from getRandomValues where randomUUID is missing", async () => {
    define(crypto, "randomUUID", undefined)
    const client = await mira()

    client.track("a")
    await client.flush()
    delete (crypto as unknown as Record<string, unknown>)["randomUUID"]

    expect(batches()[0]?.batch).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })

  it("flush() with an empty queue sends nothing", async () => {
    const client = await mira()

    await client.flush()

    expect(requests).toHaveLength(0)
  })
})

describe("page hide", () => {
  it("sends the queue with sendBeacon on pagehide", async () => {
    const client = await mira()

    client.track("a")
    window.dispatchEvent(new Event("pagehide"))

    expect(beacon).toHaveBeenCalledTimes(1)
    expect(requests.map((request) => request.via)).toEqual(["beacon"])
    expect(requests[0]?.url).toBe(`${HOST}/v1/batch/${KEY}`)
    expect(names()).toEqual(["a"])
  })

  it("sends the queue with sendBeacon when the page becomes hidden", async () => {
    const client = await mira()

    client.track("a")
    define(document, "visibilityState", "hidden")
    document.dispatchEvent(new Event("visibilitychange"))

    expect(requests.map((request) => request.via)).toEqual(["beacon"])
  })

  it("does nothing when the page becomes visible", async () => {
    const client = await mira()

    client.track("a")
    document.dispatchEvent(new Event("visibilitychange"))

    expect(requests).toHaveLength(0)
  })

  it("falls back to a keepalive fetch when sendBeacon refuses", async () => {
    const client = await mira()

    beacon.mockReturnValueOnce(false)
    client.track("a")
    window.dispatchEvent(new Event("pagehide"))
    await tick()

    expect(requests.map((request) => request.via)).toEqual(["fetch"])
    expect(requests[0]?.init?.keepalive).toBe(true)
  })

  it("falls back to a keepalive fetch without sendBeacon", async () => {
    define(navigator, "sendBeacon", undefined)
    const client = await mira()

    client.track("a")
    window.dispatchEvent(new Event("pagehide"))
    await tick()

    expect(requests[0]?.init?.keepalive).toBe(true)
  })
})

describe("retries", () => {
  it.each([408, 429, 500, 503])("retries %i with the identical body, up to 3 attempts", async (status) => {
    route(() => json({ code: "x", detail: "" }, status))
    const client = await mira()

    client.track("a")
    const done = client.flush()

    await tick(20_000)
    await done

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(new Set(requests.map((request) => request.body)).size).toBe(1)
  })

  it("retries network errors and stops at the first success", async () => {
    let calls = 0

    route(() => {
      calls++
      if (calls === 1) {
        throw new TypeError("Failed to fetch")
      }
      return undefined
    })
    const client = await mira()

    client.track("a")
    const done = client.flush()

    await tick(1000)
    await done

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requests[0]?.body).toBe(requests[1]?.body)
  })

  it("backs off with full jitter: 300·2^n", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    route(() => json({}, 503))
    const client = await mira()

    client.track("a")
    void client.flush()
    await tick(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await tick(149)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await tick(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await tick(299)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await tick(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("honours Retry-After, capped at 10 s", async () => {
    route(() => json({ code: "rate_limited", detail: "" }, 429, { "retry-after": "4" }))
    const client = await mira()

    client.track("a")
    void client.flush()
    await tick(3999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    route(() => json({ code: "rate_limited", detail: "" }, 429, { "retry-after": "120" }))
    await tick(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await tick(9999)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await tick(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("never throws into the caller", async () => {
    route(() => {
      throw new TypeError("offline")
    })
    const client = await mira()

    client.track("a")
    const done = client.flush()

    await tick(20_000)
    await expect(done).resolves.toBeUndefined()
  })

  it.each([400, 401, 403, 413])("drops a batch refused with %i and warns in development", async (status) => {
    setUrl("http://localhost:5173/")
    route(() => json({ code: "origin_not_allowed", detail: "" }, status))
    const client = await mira({ trackLocalhost: true })

    client.track("a")
    await client.flush()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(warnings()).toEqual(["[mirafive] batch: origin_not_allowed"])
  })

  it("warns in development when a receipt says nothing was counted", async () => {
    setUrl("http://localhost:5173/")
    route(() => json({ batch: "x", accepted: 0, dropped: 1, reason: "allowance_exhausted" }, 202))
    const client = await mira({ trackLocalhost: true })

    client.track("a")
    await client.flush()

    expect(warnings()).toEqual(["[mirafive] batch: allowance_exhausted"])
  })

  it("stays silent in production", async () => {
    route(() => json({ code: "origin_not_allowed", detail: "" }, 403))
    const client = await mira()

    client.track("a")
    await client.flush()

    expect(warnings()).toEqual([])
  })
})

describe("guards", () => {
  it.each([
    ["Do Not Track", () => define(navigator, "doNotTrack", "1")],
    ["Global Privacy Control", () => define(navigator, "globalPrivacyControl", true)],
    ["__mirafive_ignore", () => (w.__mirafive_ignore = true)]
  ])("sends nothing under %s", async (_, apply) => {
    apply()
    const client = await mira()

    client.track("a")
    client.pageview()
    await client.flush()

    expect(requests).toHaveLength(0)
  })

  it.each([
    "http://localhost:3000/",
    "http://127.0.0.1:8000/",
    "http://[::1]:8080/",
    "http://printer.local/",
    "file:///Users/me/site/index.html"
  ])("sends nothing from %s unless trackLocalhost is set", async (url) => {
    setUrl(url)
    const client = await mira()

    client.track("a")
    await client.flush()
    expect(requests).toHaveLength(0)

    client.destroy()
    const tracking = await mira({ trackLocalhost: true })

    tracking.track("a")
    await tracking.flush()
    expect(requests).toHaveLength(1)
  })

  it("warns once on a local host when trackLocalhost is off", async () => {
    setUrl("http://localhost:3000/")
    const client = await mira()

    client.track("a")
    client.track("b")

    expect(warnings()).toEqual(["[mirafive] local host: set trackLocalhost"])
  })

  it("defers events while prerendering and sends them when the page is shown", async () => {
    define(document, "prerendering", true)
    const client = await mira()

    client.pageview()
    client.track("a")
    await client.flush()
    expect(requests).toHaveLength(0)

    define(document, "prerendering", false)
    document.dispatchEvent(new Event("prerenderingchange"))
    await client.flush()

    expect(names()).toEqual(["$pageview", "a"])
  })
})

describe("double boot", () => {
  it("keeps a second client inert and warns in development", async () => {
    setUrl("http://localhost:3000/")
    const first = await mira({ trackLocalhost: true })
    const { createMira } = await import("../src/index.ts")
    const second = createMira({ key: KEY, trackLocalhost: true })

    second.track("b")
    await second.flush()
    first.track("a")
    await first.flush()

    expect(names()).toEqual(["a"])
    expect(warnings()).toContain("[mirafive] second client stays inert")
    second.destroy()
  })

  it("lets a new client start after destroy()", async () => {
    const first = await mira()

    first.destroy()
    const second = await mira()

    second.track("a")
    await second.flush()

    expect(names()).toEqual(["a"])
  })
})

describe("destroy", () => {
  it("drops the queue, stops timers and listeners, and runs plugin teardowns", async () => {
    const teardown = vi.fn()
    const client = await mira({ plugins: [{ name: "x", setup: () => teardown }] })

    client.track("a")
    client.destroy()
    await tick(10_000)
    window.dispatchEvent(new Event("pagehide"))
    client.track("b")
    await client.flush()

    expect(requests).toHaveLength(0)
    expect(teardown).toHaveBeenCalledTimes(1)
    expect(w.__mirafive_boot).toBeUndefined()
  })
})

describe("options", () => {
  it("refuses a secret key", async () => {
    const { createMira } = await load()

    expect(() => createMira({ key: KEY, secretKey: "mf_x" } as never)).toThrow(/secret keys are server-only/)
    expect(requests).toHaveLength(0)
  })

  it("refuses a host without a scheme", async () => {
    const { createMira } = await load()

    expect(() => createMira({ key: KEY, host: "events.mirafive.io" })).toThrow(/host needs a scheme/)
  })

  it('refuses mode "full" without identity()', async () => {
    const { createMira } = await load()

    expect(() => createMira({ key: KEY, mode: "full" })).toThrow(/identity/)
  })
})

describe("track", () => {
  it.each(["", " a", "a ", "$custom", "x".repeat(129)])(
    "drops the invalid name %j and warns",
    async (name) => {
      setUrl("http://localhost:3000/")
      const client = await mira({ trackLocalhost: true })

      client.track(name)
      await client.flush()

      expect(requests).toHaveLength(0)
      expect(warnings()[0]).toMatch(/bad name/)
    }
  )

  it("accepts names of 128 characters with inner spaces", async () => {
    const client = await mira()

    client.track("order completed")
    client.track("x".repeat(128))
    await client.flush()

    expect(names()).toEqual(["order completed", "x".repeat(128)])
  })

  it("narrows names and properties with an event map (types only)", async () => {
    const { createMira } = await load()
    const client = createMira<{ signup: { plan: string }; logout: undefined }>({ key: KEY })

    client.track("signup", { plan: "pro" })
    client.track("logout")
    // @ts-expect-error unknown event
    client.track("other")
    // @ts-expect-error properties required
    client.track("signup")
    expectTypeOf(client.track).parameter(0).toEqualTypeOf<"signup" | "logout">()
    client.destroy()
  })
})

describe("pageview()", () => {
  it("cleans the URL and sends the title and the external referrer first", async () => {
    define(document, "referrer", "https://www.google.com/")
    setUrl("https://shop.example/pricing?utm_source=news&email=a%40b.c&gclid=xyz#plans")
    const client = await mira()

    client.pageview()
    await client.flush()

    expect(events()[0]).toEqual({
      name: "$pageview",
      time: 1_727_430_000_000,
      page: {
        url: "https://shop.example/pricing?utm_source=news&gclid=xyz",
        title: "Pricing",
        referrer: "https://www.google.com/"
      }
    })
  })

  it("uses the previous page as the referrer after the first view", async () => {
    define(document, "referrer", "https://www.google.com/")
    const client = await mira()

    client.pageview()
    setUrl("https://shop.example/checkout")
    client.pageview({ title: "Kasse" })
    await client.flush()

    expect(events()[1]?.page).toEqual({
      url: "https://shop.example/checkout",
      title: "Kasse",
      referrer: "https://shop.example/pricing?utm_source=news"
    })
  })

  it("takes a given page and leaves out an empty title and referrer", async () => {
    document.title = ""
    const client = await mira()

    client.pageview({ url: "https://shop.example/a?token=secret" })
    await client.flush()

    expect(events()[0]?.page).toEqual({ url: "https://shop.example/a" })
  })

  it("truncates a title over 512 characters", async () => {
    document.title = "t".repeat(600)
    const client = await mira()

    client.pageview()
    await client.flush()

    expect(events()[0]?.page?.title).toHaveLength(512)
  })
})

describe("plugins", () => {
  it("stubs the members of missing plugins: they warn once in development and do nothing", async () => {
    setUrl("http://localhost:3000/")
    const client = await mira({ trackLocalhost: true })

    client.consent(true)
    client.consent(true)
    client.identify("u_1")
    expect(client.flag("x", "fallback")).toBe("fallback")
    expect(client.config("x", { max: 1 })).toEqual({ max: 1 })
    expect(client.anonymousId()).toBeUndefined()
    const off = client.onFlags(() => undefined)

    off()
    client.search("shoes")
    client.reset()
    client.setFlagProperties({})
    await client.flush()

    expect(requests).toHaveLength(0)
    expect(warnings()).toEqual(
      [
        "consent",
        "identify",
        "flag",
        "config",
        "anonymousId",
        "onFlags",
        "search",
        "reset",
        "setFlagProperties"
      ].map((name) => `[mirafive] ${name}() needs its plugin`)
    )
  })

  it("stubs silently in production", async () => {
    const client = await mira()

    client.consent(true)

    expect(warnings()).toEqual([])
  })

  it("gives plugins the documented core surface", async () => {
    const seen: string[] = []
    const plugin: Plugin = {
      name: "probe",
      setup(core) {
        expect(core.options).toMatchObject({ key: KEY, host: HOST, mode: "consentless" })
        expect(core.state).toMatchObject({ mode: "consentless", context: { sdk: "mirafive-browser/1.0.0" } })
        expect(core.clean("https://a.example/?utm_medium=x&q=1#h")).toBe("https://a.example/?utm_medium=x")
        expect(core.uuid()).toMatch(/^[0-9a-f-]{36}$/)
        expect(core.optedOut()).toBe(false)
        core.ready(() => seen.push("ready"))
        core.on("pageview", (href) => seen.push("pageview " + href))
        core.on("flush", () => seen.push("flush"))
        core.on("beforeSend", (event) => {
          event.properties = { ...event.properties, stamped: true }

          return event.name !== "drop"
        })
        core.expose({ hello: (name: string) => "hello " + name })
        core.send("internal", { a: 1 })
        seen.push("setup")
      }
    }
    const client = await mira({ plugins: [plugin] })

    await tick()
    expect(seen).toEqual(["setup", "ready"])
    expect((client as unknown as { hello(name: string): string }).hello("mira")).toBe("hello mira")

    client.track("drop")
    client.pageview()
    await client.flush()

    expect(seen.slice(2)).toEqual(["pageview https://shop.example/pricing?utm_source=news&secret=1", "flush"])
    expect(events().map((event) => [event.name, event.properties])).toEqual([
      ["internal", { a: 1, stamped: true }],
      ["$pageview", { stamped: true }]
    ])
  })

  it("runs a plugin added with use() after creation, and a plugin method replaces its stub", async () => {
    const client = await mira()

    client.use({
      name: "search",
      setup: (core) => core.expose({ search: (query: string) => core.send("x", { query }) })
    })
    client.search("shoes")
    await client.flush()

    expect(events()[0]?.properties).toEqual({ query: "shoes" })
  })

  it("lets the hosted tracker name itself in context.sdk", async () => {
    const client = await mira({
      plugins: [
        { name: "tracker", setup: (core) => void (core.state.context.sdk = "mirafive-tracker/1.0.0") }
      ]
    })

    client.track("a")
    await client.flush()

    expect(batches()[0]?.context).toEqual({ sdk: "mirafive-tracker/1.0.0" })
  })

  it("types the client", async () => {
    const { createMira } = await load()

    expectTypeOf(createMira).returns.toEqualTypeOf<Mira>()
  })
})

describe("review fixes", () => {
  it("cuts page fields for every event without splitting a surrogate pair", async () => {
    document.title = "t".repeat(511) + "😀"
    define(document, "referrer", "https://ref.example/" + "r".repeat(2027) + "😀")
    const client = await mira()

    client.pageview()
    await client.flush()

    const page = events()[0]?.page

    expect(page?.title).toBe("t".repeat(511))
    expect(page?.referrer).toHaveLength(2047)
    expect(requests[0]?.body).not.toMatch(/\\ud[89a-f]/)
  })

  it("cuts the page URL of track() too", async () => {
    setUrl("https://shop.example/" + "p".repeat(3000))
    const client = await mira()

    client.track("a")
    await client.flush()

    expect(events()[0]?.page?.url).toHaveLength(2048)
  })

  it.each([
    ["65 leaves", Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`k${index}`, index]))],
    [
      "65 leaves counting empty objects and lists",
      {
        a: {},
        b: [],
        ...Object.fromEntries(Array.from({ length: 63 }, (_, index) => [`k${index}`, { x: index }]))
      }
    ],
    ["depth 6", { a: { b: { c: { d: { e: { f: 1 } } } } } }],
    ["a key over 128 characters", { ["k".repeat(129)]: 1 }],
    ["over 32768 bytes of UTF-8", { text: "€".repeat(11_000) }],
    ["a lone surrogate", { text: "a\ud800b" }]
  ])("drops one event with %s and keeps the rest of the batch", async (_, properties) => {
    setUrl("http://localhost:3000/")
    const client = await mira({ trackLocalhost: true })

    client.track("bad", properties)
    client.track("good", { plan: "pro" })
    await client.flush()

    expect(names()).toEqual(["good"])
    expect(warnings()).toContain("[mirafive] event dropped: bad")
  })

  it("accepts what the server accepts: 64 leaves, lists as one leaf, index-keyed objects, depth 5", async () => {
    const client = await mira()

    client.track("leaves", Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`k${index}`, index])))
    client.track("lists", {
      items: Array.from({ length: 200 }, (_, index) => index),
      indexed: { 0: "a", 1: "b" }
    })
    client.track("deep", { a: { b: { c: { d: { e: 1 } } } } })
    client.track("bytes", { text: "x".repeat(32_000) })
    await client.flush()

    expect(names()).toEqual(["leaves", "lists", "deep", "bytes"])
  })

  it("beacons a batch still in flight when the page hides", async () => {
    route((request) => (request.url.includes("/v1/batch/") ? new Promise(() => undefined) : undefined))
    const client = await mira()

    client.track("a")
    void client.flush()
    await tick()
    window.dispatchEvent(new Event("pagehide"))

    expect(beacon).toHaveBeenCalledTimes(1)
    expect(requests.map((request) => request.via)).toEqual(["fetch", "beacon"])
    expect(requests[1]?.body).toBe(requests[0]?.body)
  })

  it.each([
    ["clear()", (client: Mira) => client.use({ name: "x", setup: (core) => core.clear() })],
    ["destroy()", (client: Mira) => client.destroy()]
  ])("cancels a batch waiting for a retry on %s", async (_, stop) => {
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    route(() => json({}, 503))
    const client = await mira()

    client.track("a")
    void client.flush()
    await tick()
    stop(client)
    await tick(20_000)

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("requires a string event name and treats pageview(null) as pageview()", async () => {
    setUrl("http://localhost:3000/")
    const client = await mira({ trackLocalhost: true })

    client.track(123 as unknown as string)
    client.pageview(null)
    await client.flush()

    expect(names()).toEqual(["$pageview"])
    expect(warnings()).toContain("[mirafive] bad name: 123")
  })

  it("clamps flushAt and flushAfterMs and warns in development", async () => {
    setUrl("http://localhost:3000/")
    const client = await mira({ trackLocalhost: true, flushAt: 5000, flushAfterMs: 1 })

    client.track("a")
    await tick(49)
    expect(requests).toHaveLength(0)
    await tick(1)

    expect(requests).toHaveLength(1)
    expect(warnings()).toEqual(["[mirafive] flushAt: 1–1000", "[mirafive] flushAfterMs: 50–300000"])
  })
})

const loader = async (more: Plugin[] = []) => {
  let core: MiraCore | undefined
  const client = await mira({
    mode: "full",
    plugins: [{ name: "identity", setup: (given) => void (core = given) }, ...more]
  })

  return { client, core: core as MiraCore }
}

describe("hold()", () => {
  it("holds events between a grant and identity(), then sends them with their times and ids", async () => {
    const { client, core } = await loader()

    core.hold()
    client.track("a")
    vi.setSystemTime(1_727_430_001_000)
    client.track("b")
    w.__mirafive_consent = { statistics: true }
    client.use(identity())
    await client.flush()

    expect(events().map((event) => [event.name, event.time, !!event.anonymousId])).toEqual([
      ["a", 1_727_430_000_000, true],
      ["b", 1_727_430_001_000, true]
    ])
  })

  it("drops held events on a decline", async () => {
    const { client, core } = await loader()

    core.hold()
    client.track("a")
    client.use(identity())
    client.consent(false)
    client.consent(true)
    await client.flush()

    expect(requests).toHaveLength(0)
  })

  it("holds at most 100 events", async () => {
    const { client, core } = await loader()

    core.hold()

    for (let index = 0; index < 150; index++) {
      client.track("e" + index)
    }

    client.use(identity())
    client.consent(true)
    await client.flush()

    expect(events()).toHaveLength(100)
  })

  it("resends the page viewed before the grant, and a navigation during the hold once", async () => {
    const { client, core } = await loader([pageviews()])

    await tick()
    core.hold()
    history.pushState({}, "", "/checkout")
    await tick()
    w.__mirafive_consent = { statistics: true }
    client.use(identity())
    await client.flush()

    expect(events().map((event) => [event.name, event.page?.url])).toEqual([
      ["$pageview", "https://shop.example/pricing?utm_source=news"],
      ["$pageview", "https://shop.example/checkout"]
    ])
  })

  it("counts a landing pageview held before identity arrives once", async () => {
    let core: MiraCore | undefined
    const client = (await factory())({
      mode: "full",
      plugins: [{ name: "identity", setup: (given) => void (core = given) }, pageviews()]
    })

    core?.hold()
    await tick()
    w.__mirafive_consent = { statistics: true }
    client.use(identity())
    await client.flush()

    expect(names()).toEqual(["$pageview"])
  })

  it("holds nothing without hold()", async () => {
    const { client } = await loader()

    client.track("a")
    client.use(identity())
    client.consent(true)
    await client.flush()

    expect(requests).toHaveLength(0)
  })
})
