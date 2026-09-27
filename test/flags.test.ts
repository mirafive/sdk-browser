import { describe, expect, it, vi } from "vitest"

import { flags } from "../src/flags.ts"
import type { FlagsOptions } from "../src/flags.ts"
import { identity } from "../src/identity.ts"
import { pageviews } from "../src/pageviews.ts"
import { bucket, fnv1a32 } from "../src/protocol/hash.ts"
import type { Flag, FlagDocument } from "../src/protocol/types.ts"
import type { Plugin } from "../src/types.ts"
import {
  HOST,
  KEY,
  NS,
  define,
  events,
  json,
  mira,
  requests,
  route,
  setUrl,
  tick,
  w,
  warnings
} from "./helpers.ts"

const NOW = 1_727_430_000_000
const SEED = "3f9a1c0b7e2d"

const experiment: Flag = {
  s: SEED,
  t: "m",
  u: "b",
  d: "a",
  e: "r",
  c: "b",
  p: { a: { price: 10 }, b: { price: 12 } },
  r: [
    {
      w: [
        ["a", 5000],
        ["b", 5000]
      ]
    }
  ]
}

const doc: FlagDocument = {
  v: 1,
  at: NOW,
  flags: {
    "new-checkout": { s: SEED, t: "b", u: "b", d: "off", r: [{ x: "on" }] },
    "pricing-test": experiment,
    "server-test": { ...experiment, c: "s" },
    limits: {
      s: SEED,
      t: "c",
      u: "p",
      d: "free",
      p: { free: { max: 1 }, pro: { max: 3 } },
      r: [{ if: [["p", "plan", "is", ["pro"]]], x: "pro" }]
    },
    beta: { s: SEED, t: "b", u: "b", d: "off", r: [{ if: [["s", "3fa9c1e07b"]], x: "on" }] },
    newsletter: {
      s: SEED,
      t: "b",
      u: "b",
      d: "off",
      r: [{ if: [["p", "$utm_source", "is", ["news"]]], x: "on" }]
    }
  }
}

const values = { v: 1, at: NOW, values: { "new-checkout": ["on"], limits: ["free", { max: 1 }] } }

/** An anonymous id the experiment splits into `variant`. */
const idFor = (variant: "a" | "b"): string => {
  for (let index = 0; ; index++) {
    const id = `0199a3f2-7c1e-7a4b-9f00-${String(index).padStart(12, "0")}`

    if ((bucket(SEED, ".v", id) < 5000 ? "a" : "b") === variant) {
      return id
    }
  }
}

const serve = (body: unknown = doc, status = 200, headers: Record<string, string> = {}) =>
  route((request) => (request.url.includes("/v1/flags/") ? json(body, status, headers) : undefined))

const flagRequests = () => requests.filter((request) => request.url.includes("/v1/flags/"))

const exposures = () =>
  events()
    .filter((event) => event.name === "$exposure")
    .map((event) => event.properties)

const full = (options?: FlagsOptions, more: Plugin[] = []) =>
  mira({ mode: "full", plugins: [pageviews(), identity(), flags(options), ...more] })

const bootstrapBlock = (content: unknown): void => {
  const script = document.createElement("script")

  script.type = "application/json"
  script.id = "mirafive-flags"
  script.textContent = JSON.stringify(content)
  document.head.append(script)
}

describe("consentless", () => {
  it("fetches the values view without cookies, cache or referrer and answers from it", async () => {
    serve(values)
    const client = await mira({ plugins: [flags()] })

    await tick()

    expect(flagRequests()).toHaveLength(1)
    expect(flagRequests()[0]).toMatchObject({ url: `${HOST}/v1/flags/${KEY}?view=values`, method: "GET" })
    expect(flagRequests()[0]?.init).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer"
    })
    expect(client.flag("new-checkout", false)).toBe(true)
    expect(client.config("limits", { max: 0 })).toEqual({ max: 1 })
    expect(client.flag("unknown", "fallback")).toBe("fallback")
  })

  it("answers fallbacks until the flags arrive, and when the fetch fails", async () => {
    serve({ code: "x", detail: "" }, 500)
    const client = await mira({ plugins: [flags()] })

    expect(client.flag("new-checkout", false)).toBe(false)
    await tick()
    expect(client.flag("new-checkout", false)).toBe(false)
  })

  it("ignores overrides", async () => {
    serve(values)
    const client = await mira({ plugins: [flags({ overrides: { "new-checkout": false } })] })

    await tick()

    expect(client.flag("new-checkout", false)).toBe(true)
  })

  it("warns in development about a flag the source does not have", async () => {
    setUrl("http://localhost:3000/")
    serve(values)
    const client = await mira({ plugins: [flags()], trackLocalhost: true })

    await tick()
    client.flag("typo", false)

    expect(warnings()).toEqual([`[mirafive] flag "typo" is unknown`])
  })
})

describe("full: the browser document", () => {
  it("fetches the browser document and evaluates it", async () => {
    serve()
    const client = await full()

    await tick()

    expect(flagRequests()[0]).toMatchObject({ url: `${HOST}/v1/flags/${KEY}`, method: "GET" })
    expect(client.flag("new-checkout", false)).toBe(true)
    expect(client.config("limits", { max: 0 })).toEqual({ max: 1 })
    expect(client.flag("beta", false)).toBe(false)
  })

  it("uses identify() traits and setFlagProperties() as facts, and the page's utm_source", async () => {
    serve()
    const client = await full()

    await tick()
    client.identify("u_1", { plan: "pro" })
    expect(client.config("limits", { max: 0 })).toEqual({ max: 3 })
    client.setFlagProperties({ plan: "free" })
    expect(client.config("limits", { max: 0 })).toEqual({ max: 1 })
    expect(client.flag("newsletter", false)).toBe(true)
  })

  it("keeps the last document when a refresh fails", async () => {
    serve()
    const client = await full()

    await tick()
    serve({ code: "sink_unavailable", detail: "" }, 503)
    await tick(300_000)

    expect(flagRequests()).toHaveLength(2)
    expect(client.flag("new-checkout", false)).toBe(true)
  })

  it("ignores a document of another version", async () => {
    serve({ ...doc, v: 2 })
    const client = await full()

    await tick()

    expect(client.flag("new-checkout", false)).toBe(false)
  })
})

describe("bootstrap", () => {
  it("answers from a fresh <script> block without fetching", async () => {
    bootstrapBlock({
      v: 1,
      at: NOW - 10_000,
      values: { "new-checkout": ["on"], limits: ["pro", { max: 3 }] }
    })
    const client = await full()

    expect(client.flag("new-checkout", false)).toBe(true)
    expect(client.config("limits", {})).toEqual({ max: 3 })
    await tick()
    expect(flagRequests()).toHaveLength(0)
  })

  it("fetches at once when the block is older than 60 s or lists browser keys", async () => {
    bootstrapBlock({ v: 1, at: NOW - 61_000, values: {} })
    await full()
    await tick()
    expect(flagRequests()).toHaveLength(1)
  })

  it("fetches at once when the block leaves keys to the browser", async () => {
    bootstrapBlock({ v: 1, at: NOW, values: {}, browser: ["pricing-test"] })
    await full()
    await tick()
    expect(flagRequests()).toHaveLength(1)
  })

  it("ignores a block older than 7 days", async () => {
    bootstrapBlock({ v: 1, at: NOW - 8 * 86_400_000, values: { "new-checkout": ["on"] } })
    route(() => new Promise(() => undefined))
    const client = await full()

    expect(client.flag("new-checkout", false)).toBe(false)
  })

  it("takes the bootstrap option, and the block over it", async () => {
    const client = await mira({
      plugins: [
        flags({
          bootstrap: { v: 1, at: NOW, values: { "new-checkout": ["off"], limits: ["pro", { max: 3 }] } }
        })
      ]
    })

    expect(client.flag("new-checkout", true)).toBe(false)
    client.destroy()

    bootstrapBlock({ v: 1, at: NOW, values: { "new-checkout": ["on"] } })
    const again = await mira({
      plugins: [flags({ bootstrap: { v: 1, at: NOW, values: { "new-checkout": ["off"] } } })]
    })

    expect(again.flag("new-checkout", false)).toBe(true)
  })

  it("sends no server-decided exposure when read before the matching identify()", async () => {
    bootstrapBlock({
      v: 1,
      at: NOW,
      values: { "pricing-test": ["b", null, 1] },
      unit: String(fnv1a32("u_42"))
    })
    w.__mirafive_consent = { statistics: true, experiments: true }
    const client = await full()

    expect(client.flag("pricing-test", "a")).toBe("b")
    expect(client.config("pricing-test", "none")).toBe("none")
    client.identify("u_42")
    client.flag("pricing-test", "a")
    client.flag("pricing-test", "a")
    await client.flush()

    expect(exposures()).toEqual([])
  })

  it("sends the exposure when the identified user matches", async () => {
    bootstrapBlock({
      v: 1,
      at: NOW,
      values: { "pricing-test": ["b", null, 1] },
      unit: String(fnv1a32("u_42"))
    })
    w.__mirafive_consent = { statistics: true, experiments: true }
    const client = await full()

    client.identify("u_42")
    client.flag("pricing-test", "a")
    await client.flush()

    expect(exposures()).toEqual([{ $experiment: "pricing-test", $variant: "b", $boot: 1 }])
  })
})

const membership = (segments: string[]) => ({
  document: doc,
  membership: { segments, unavailable: [], refreshedAt: NOW, stale: false }
})

describe("segments", () => {
  it("posts the lookup with targeting consent and answers segment rules from it", async () => {
    localStorage.setItem(`mirafive:${NS}:aid`, "5f0c1c8e-3e0e-4a57-9d59-3f7f2a6d1e44.1727000000000")
    w.__mirafive_consent = { statistics: true, targeting: true }
    serve(membership(["3fa9c1e07b"]))
    const client = await full()

    await tick()

    const [request] = flagRequests()

    expect(request?.method).toBe("POST")
    expect(JSON.parse(request?.body ?? "")).toEqual({
      anonymousId: "5f0c1c8e-3e0e-4a57-9d59-3f7f2a6d1e44",
      identified: false
    })
    expect(
      new Request("https://x.example", { method: "POST", body: request?.body ?? "" }).headers.get(
        "content-type"
      )
    ).toBe("text/plain;charset=UTF-8")
    expect(client.flag("beta", false)).toBe(true)
  })

  it("answers the fallback while the lookup is out, for at most 800 ms", async () => {
    w.__mirafive_consent = { statistics: true, targeting: true }
    bootstrapBlock({ ...doc, at: NOW - 61_000, values: undefined })
    route(() => new Promise(() => undefined))
    const client = await full()
    const heard = vi.fn()

    client.onFlags(heard)
    heard.mockClear()
    expect(client.flag("beta", true)).toBe(true)
    await tick(800)

    expect(client.flag("beta", true)).toBe(false)
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it("never looks up without targeting consent", async () => {
    w.__mirafive_consent = { statistics: true, experiments: true }
    serve()
    const client = await full()

    await tick()

    expect(flagRequests().map((request) => request.method)).toEqual(["GET"])
    expect(client.flag("beta", true)).toBe(false)
  })

  it("looks up once targeting is granted", async () => {
    serve(membership(["3fa9c1e07b"]))
    const client = await full()

    await tick()
    client.consent({ statistics: true, targeting: true })
    await tick()

    expect(flagRequests().map((request) => request.method)).toEqual(["GET", "POST"])
    expect(client.flag("beta", false)).toBe(true)
  })

  it("never looks up under Do Not Track", async () => {
    define(navigator, "doNotTrack", "1")
    w.__mirafive_consent = { statistics: true, targeting: true }
    serve()
    await full()
    await tick()

    expect(flagRequests().map((request) => request.method)).toEqual(["GET"])
  })
})

describe("previews and overrides", () => {
  it("answers ?mirafive-preview=key:variant for a variant the flag has, and never exposes it", async () => {
    setUrl("https://shop.example/?mirafive-preview=pricing-test:b&mirafive-preview=new-checkout:nope")
    w.__mirafive_consent = { statistics: true, experiments: true }
    serve()
    const client = await full()

    await tick()

    expect(client.flag("pricing-test", "a")).toBe("b")
    expect(client.config("pricing-test", {})).toEqual({ price: 12 })
    expect(client.flag("new-checkout", false)).toBe(true)
    await client.flush()
    expect(exposures()).toEqual([])
  })

  it("forwards the preview token on the browser view", async () => {
    setUrl("https://shop.example/?mirafive-preview-token=t%2F1")
    serve()
    await full()
    await tick()

    expect(flagRequests()[0]?.url).toBe(`${HOST}/v1/flags/${KEY}?mirafive-preview-token=t%2F1`)
  })

  it("answers overrides in mode full and never exposes them", async () => {
    w.__mirafive_consent = { statistics: true, experiments: true }
    serve()
    const client = await full({ overrides: { "new-checkout": false, "pricing-test": "b", limits: "pro" } })

    await tick()

    expect(client.flag("new-checkout", true)).toBe(false)
    expect(client.flag("pricing-test", "a")).toBe("b")
    expect(client.config("limits", {})).toEqual({ max: 3 })
    await client.flush()
    expect(exposures()).toEqual([])
  })
})

describe("exposures", () => {
  it("sends one $exposure per flag and page load, with the experiments scope", async () => {
    localStorage.setItem(`mirafive:${NS}:aid`, `${idFor("b")}.1727000000000`)
    w.__mirafive_consent = { statistics: true, experiments: true }
    serve()
    const client = await full()

    await tick()
    expect(client.flag("pricing-test", "a")).toBe("b")
    expect(client.config("pricing-test", {})).toEqual({ price: 12 })
    client.flag("pricing-test", "a")
    client.flag("new-checkout", false)
    await client.flush()

    expect(exposures()).toEqual([{ $experiment: "pricing-test", $variant: "b", $boot: 1 }])
    expect(events().find((event) => event.name === "$exposure")?.anonymousId).toBe(idFor("b"))
  })

  it("never exposes a server-counted experiment", async () => {
    w.__mirafive_consent = { statistics: true, experiments: true }
    serve()
    const client = await full()

    await tick()
    client.flag("server-test", "a")
    await client.flush()

    expect(exposures()).toEqual([])
  })

  it("draws random-mode experiments on a pending id before consent, then counts them under it", async () => {
    serve()
    const client = await full()

    await tick()
    const shown = client.flag("pricing-test", "a")
    const pending = w.__mirafive_aid_next

    expect(pending).toMatch(/^[0-9a-f-]{36}$/)
    expect(localStorage.length).toBe(0)
    client.consent({ statistics: true, experiments: true })
    await client.flush()

    expect(client.anonymousId()).toBe(pending)
    expect(exposures()).toEqual([{ $experiment: "pricing-test", $variant: shown, $boot: 0 }])
  })

  it("holds exposures until the experiments scope and drops them on a decline", async () => {
    w.__mirafive_consent = { statistics: true }
    serve()
    const client = await full()

    await tick()
    client.flag("pricing-test", "a")
    await client.flush()
    expect(exposures()).toEqual([])

    client.consent({ experiments: false })
    client.consent({ experiments: true })
    await client.flush()

    expect(exposures()).toEqual([])
  })

  it("keeps the variant this page first showed", async () => {
    localStorage.setItem(`mirafive:${NS}:aid`, `${idFor("a")}.1727000000000`)
    w.__mirafive_consent = { statistics: true, experiments: true }
    serve()
    const client = await full()

    await tick()
    expect(client.flag("pricing-test", "x")).toBe("a")
    client.reset()
    localStorage.setItem(`mirafive:${NS}:aid`, `${idFor("b")}.1727000000000`)

    expect(client.flag("pricing-test", "x")).toBe("a")
  })

  it("sends nothing when the counted id now gives another variant", async () => {
    w.__mirafive_consent = { statistics: true }
    localStorage.setItem(`mirafive:${NS}:aid`, `${idFor("a")}.1727000000000`)
    serve()
    const client = await full()

    await tick()
    w.__mirafive_aid_next = idFor("b")
    client.flag("pricing-test", "x")
    client.consent({ experiments: true })
    await client.flush()

    expect(exposures()).toEqual([])
  })

  it("sends nothing under Global Privacy Control", async () => {
    define(navigator, "globalPrivacyControl", true)
    w.__mirafive_consent = { statistics: true, experiments: true }
    serve()
    const client = await full()

    await tick()

    expect(client.flag("pricing-test", "fallback")).toBe("a")
    await client.flush()
    expect(requests.filter((request) => request.url.includes("/v1/batch/"))).toHaveLength(0)
  })
})

describe("page experiments in flags", () => {
  it("answers the snippet's variant", async () => {
    w.__mirafive_experiments = [{ k: "hero", v: "b", s: SEED, w: [5000, 5000], m: "r", h: "fa1adf55", b: 0 }]
    serve()
    const client = await full()

    await tick()

    expect(client.flag("hero", "a")).toBe("b")
  })

  it("answers the original for experiments in orig and marks <html>", async () => {
    w.__mirafive_experiments = [{ k: "hero", v: "b", s: SEED, w: [5000, 5000], m: "r", h: "fa1adf55", b: 0 }]
    serve({ ...doc, orig: ["hero"] })
    const client = await full()

    await tick()

    expect(client.flag("hero", "b")).toBe("a")
    expect(document.documentElement.getAttribute("data-mirafive-hero")).toBe("a")
  })
})

describe("listeners and refetching", () => {
  it("calls onFlags on load and on change, not when only `at` changed, and stops after unsubscribe", async () => {
    serve()
    const client = await full()
    const heard = vi.fn()
    const off = client.onFlags(heard)

    await tick()
    expect(heard).toHaveBeenCalledTimes(1)

    serve({ ...doc, at: NOW + 1 })
    await tick(300_000)
    expect(heard).toHaveBeenCalledTimes(1)

    serve({ ...doc, flags: { ...doc.flags, "new-checkout": { ...doc.flags["new-checkout"], off: 1 } } })
    await tick(300_000)
    expect(heard).toHaveBeenCalledTimes(2)
    expect(client.flag("new-checkout", true)).toBe(false)

    off()
    client.setFlagProperties({ plan: "pro" })
    expect(heard).toHaveBeenCalledTimes(2)
  })

  it("calls a late listener at once", async () => {
    serve()
    const client = await full()

    await tick()
    const heard = vi.fn()

    client.onFlags(heard)

    expect(heard).toHaveBeenCalledTimes(1)
  })

  it("refetches every refreshSeconds while visible, and on becoming visible", async () => {
    serve()
    await full({ refreshSeconds: 60 })

    await tick()
    await tick(60_000)
    expect(flagRequests()).toHaveLength(2)

    define(document, "visibilityState", "hidden")
    await tick(60_000)
    expect(flagRequests()).toHaveLength(2)

    define(document, "visibilityState", "visible")
    document.dispatchEvent(new Event("visibilitychange"))
    await tick()
    expect(flagRequests()).toHaveLength(3)
  })

  it("refetches when a pageview moves to another URL", async () => {
    serve()
    await full()

    await tick()
    history.pushState({}, "", "/next")
    await tick()
    history.replaceState({ same: true }, "", "/next")
    await tick()

    expect(flagRequests()).toHaveLength(2)
  })

  it("backs off after a 429 for Retry-After", async () => {
    serve({ code: "rate_limited", detail: "" }, 429, { "retry-after": "600" })
    await full({ refreshSeconds: 60 })

    await tick()
    await tick(540_000)
    expect(flagRequests()).toHaveLength(1)
    await tick(60_000)
    expect(flagRequests()).toHaveLength(2)
  })

  it("stops on destroy", async () => {
    serve()
    const client = await full({ refreshSeconds: 60 })

    await tick()
    client.destroy()
    await tick(600_000)

    expect(flagRequests()).toHaveLength(1)
  })
})
