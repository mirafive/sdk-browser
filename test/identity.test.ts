import { describe, expect, it, vi } from "vitest"

import { identity } from "../src/identity.ts"
import { pageviews } from "../src/pageviews.ts"
import {
  NS,
  batches,
  define,
  events,
  factory,
  mira,
  names,
  requests,
  setUrl,
  tick,
  w,
  warnings
} from "./helpers.ts"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const stored = (name: string): string | null => localStorage.getItem(`mirafive:${NS}:${name}`)
const full = () => mira({ mode: "full", plugins: [pageviews(), identity()] })

describe("before consent", () => {
  it("sends and stores nothing", async () => {
    const client = await full()

    await tick()
    client.track("a")
    client.identify("u_1", { plan: "pro" })
    await client.flush()
    await tick(10_000)

    expect(requests).toHaveLength(0)
    expect(localStorage.length).toBe(0)
    expect(client.anonymousId()).toBeUndefined()
  })
})

describe("consent(true)", () => {
  it("grants statistics, resends the landing pageview and stamps ids", async () => {
    define(document, "referrer", "https://www.google.com/")
    const client = await full()

    await tick()
    client.consent(true)
    client.track("a")
    await client.flush()

    const [batch] = batches()

    expect(batch?.mode).toBe("full")
    expect(batch?.context).toEqual({
      sdk: "mirafive-browser/0.5.0",
      locale: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      screen: [screen.width, screen.height]
    })
    expect(names()).toEqual(["$pageview", "a"])
    const [pageview, custom] = events()

    expect(pageview?.page).toEqual({
      url: "https://shop.example/pricing?utm_source=news",
      title: "Pricing",
      referrer: "https://www.google.com/"
    })
    expect(pageview?.properties).toBeUndefined()
    expect(pageview?.anonymousId).toMatch(UUID)
    expect(pageview?.sessionId).toMatch(UUID)
    expect(custom?.anonymousId).toBe(pageview?.anonymousId)
    expect(custom?.sessionId).toBe(pageview?.sessionId)
    expect(client.anonymousId()).toBe(pageview?.anonymousId)
    expect(stored("aid")).toBe(`${pageview?.anonymousId}.1727430000000`)
    expect(stored("sid")).toBe(`${pageview?.sessionId}.1727430000000`)
  })

  it("resends the landing pageview only on the first grant", async () => {
    const client = await full()

    await tick()
    client.consent(true)
    client.consent(false)
    client.consent(true)
    await client.flush()

    expect(names()).toEqual([])
    client.track("a")
    await client.flush()
    expect(names()).toEqual(["a"])
  })

  it("marks pageviews with $boot: 1 when the answer came before the page drew", async () => {
    const client = (await factory())({ mode: "full", plugins: [pageviews(), identity()] })

    client.consent(true)
    await tick()
    history.pushState({}, "", "/next")
    await tick()
    await client.flush()

    expect(events().map((event) => event.properties)).toEqual([{ $boot: 1 }, { $boot: 1 }])
  })

  it("leaves $boot out when the answer came after the landing pageview", async () => {
    const client = await full()

    await tick()
    client.consent(true)
    await client.flush()

    expect(events()[0]?.properties).toBeUndefined()
  })
})

describe("scopes", () => {
  it("keeps each scope's last answer until it is named again", async () => {
    const client = await full()
    const seen: unknown[] = []

    client.use({
      name: "probe",
      setup: (core) => void core.on("consent", (answer) => seen.push({ ...answer }))
    })
    client.consent({ experiments: true })
    client.consent(true)
    client.consent({ targeting: true, experiments: false })

    expect(seen).toEqual([
      { experiments: true },
      { experiments: true, statistics: true },
      { experiments: false, statistics: true, targeting: true }
    ])
  })

  it("sends nothing with experiments or targeting alone", async () => {
    const client = await full()

    await tick()
    client.consent({ experiments: true, targeting: true })
    client.track("a")
    await client.flush()

    expect(requests).toHaveLength(0)
  })

  it("withdrawing statistics clears the queue and switches back to consentless", async () => {
    const client = await full()
    let mode = ""

    client.use({ name: "probe", setup: (core) => void core.on("consent", () => (mode = core.state.mode)) })
    client.consent(true)
    client.track("a")
    client.consent({ statistics: false, experiments: true })
    await client.flush()

    expect(requests).toHaveLength(0)
    expect(mode).toBe("consentless")
    expect(stored("aid")).not.toBeNull()
  })
})

describe("consent(false)", () => {
  it("clears the queue, the user and every local key", async () => {
    const client = await full()

    client.consent(true)
    client.identify("u_1")
    client.track("a")
    expect(localStorage.length).toBe(3)
    client.consent(false)
    await client.flush()

    expect(requests).toHaveLength(0)
    expect(localStorage.length).toBe(0)
    expect(client.anonymousId()).toBeUndefined()

    client.consent(true)
    client.track("b")
    await client.flush()
    expect(events()[0]?.userId).toBeUndefined()
  })

  it("forgets ids left by an earlier visit when declined on a fresh load", async () => {
    localStorage.setItem(`mirafive:${NS}:aid`, "old.1727000000000")
    const client = await full()

    client.consent(false)

    expect(localStorage.length).toBe(0)
  })
})

describe("window.__mirafive_consent", () => {
  it("applies a stored answer at setup", async () => {
    w.__mirafive_consent = { statistics: true, experiments: false, targeting: false }
    const client = await full()

    await tick()
    await client.flush()

    expect(names()).toEqual(["$pageview"])
    expect(events()[0]?.properties).toEqual({ $boot: 1 })
  })

  it("applies a stored decline", async () => {
    localStorage.setItem(`mirafive:${NS}:aid`, "old.1727000000000")
    w.__mirafive_consent = false
    await full()

    expect(localStorage.length).toBe(0)
  })

  it("works when identity() is added after the landing pageview", async () => {
    const { createMira } = await import("../src/index.ts")
    const client = createMira({
      key: "mf_ab12cd34_x",
      mode: "full",
      plugins: [{ name: "identity", setup() {} }, pageviews()]
    })

    await tick()
    w.__mirafive_consent = { statistics: true }
    client.use(identity())
    await client.flush()
    client.destroy()

    expect(names()).toEqual(["$pageview"])
    expect(events()[0]).toMatchObject({ anonymousId: expect.stringMatching(UUID), properties: { $boot: 1 } })
  })
})

describe("ids", () => {
  it("adopts window.__mirafive_aid_next as the anonymous id, once", async () => {
    w.__mirafive_aid_next = "0199a3f2-7c1e-7a4b-9f00-000000000001"
    const client = await full()

    client.consent(true)

    expect(client.anonymousId()).toBe("0199a3f2-7c1e-7a4b-9f00-000000000001")
    expect(w.__mirafive_aid_next).toBeUndefined()
    client.reset()
    client.consent(true)
    expect(client.anonymousId()).not.toBe("0199a3f2-7c1e-7a4b-9f00-000000000001")
  })

  it("keeps a stored anonymous id over a pending one", async () => {
    localStorage.setItem(`mirafive:${NS}:aid`, "5f0c1c8e-3e0e-4a57-9d59-3f7f2a6d1e44.1727000000000")
    w.__mirafive_aid_next = "0199a3f2-7c1e-7a4b-9f00-000000000001"
    const client = await full()

    client.consent(true)

    expect(client.anonymousId()).toBe("5f0c1c8e-3e0e-4a57-9d59-3f7f2a6d1e44")
  })

  it("reads a bare legacy anonymous id and stamps it", async () => {
    localStorage.setItem(`mirafive:${NS}:aid`, "5f0c1c8e-3e0e-4a57-9d59-3f7f2a6d1e44")
    const client = await full()

    client.consent(true)

    expect(client.anonymousId()).toBe("5f0c1c8e-3e0e-4a57-9d59-3f7f2a6d1e44")
    expect(stored("aid")).toBe("5f0c1c8e-3e0e-4a57-9d59-3f7f2a6d1e44.1727430000000")
  })

  it("replaces an anonymous id unseen for 365 days", async () => {
    localStorage.setItem(`mirafive:${NS}:aid`, `old.${1_727_430_000_000 - 31_536_000_000}`)
    const client = await full()

    client.consent(true)

    expect(client.anonymousId()).toMatch(UUID)
  })

  it("starts a new session after 30 idle minutes, keeps it while active", async () => {
    const client = await full()

    client.consent(true)
    client.track("a")
    vi.setSystemTime(1_727_430_000_000 + 29 * 60_000)
    client.track("b")
    vi.setSystemTime(1_727_430_000_000 + 59 * 60_000)
    client.track("c")
    vi.setSystemTime(1_727_430_000_000 + 89 * 60_000 + 1)
    client.track("d")
    await client.flush()

    const [a, b, c, d] = events().map((event) => event.sessionId)

    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(d).not.toBe(c)
  })

  it("keeps working in memory when storage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError")
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError")
    })
    const client = await full()

    client.consent(true)
    client.track("a")
    client.track("b")
    await client.flush()

    const [a, b] = events()

    expect(a?.anonymousId).toMatch(UUID)
    expect(b?.anonymousId).toBe(a?.anonymousId)
    expect(b?.sessionId).toBe(a?.sessionId)
  })
})

describe("identify()", () => {
  it("sends $identify with traits and stamps userId on later events", async () => {
    const client = await full()

    client.consent(true)
    client.identify("u_42", { plan: "pro" })
    client.track("a")
    await client.flush()

    expect(
      events()
        .slice(1)
        .map((event) => [event.name, event.userId, event.properties])
    ).toEqual([
      ["$identify", "u_42", { plan: "pro" }],
      ["a", "u_42", undefined]
    ])
    expect(stored("uid")).toMatch(/^[0-9a-z]+\.1727430000000$/)
    expect(stored("uid")).not.toContain("u_42")
  })

  it("keeps the anonymous id when the first user signs in", async () => {
    const client = await full()

    client.consent(true)
    const before = client.anonymousId()

    client.identify("u_1")

    expect(client.anonymousId()).toBe(before)
  })

  it("resets anonymous id and session when a different user signs in", async () => {
    const client = await full()

    client.consent(true)
    client.identify("u_1")
    client.track("a")
    client.identify("u_2")
    client.track("b")
    await client.flush()

    const a = events().find((event) => event.name === "a")
    const b = events().find((event) => event.name === "b")

    expect(b?.anonymousId).not.toBe(a?.anonymousId)
    expect(b?.sessionId).not.toBe(a?.sessionId)
  })

  it("checks a user identified before consent once consent is given", async () => {
    localStorage.setItem(`mirafive:${NS}:aid`, "previous-person.1727000000000")
    localStorage.setItem(`mirafive:${NS}:uid`, "zzz.1727000000000")
    const client = await full()

    client.identify("u_2")
    client.consent(true)

    expect(client.anonymousId()).not.toBe("previous-person")
  })

  it("warns in development when the user id looks like an email", async () => {
    setUrl("http://localhost:3000/")
    const client = await mira({ mode: "full", plugins: [identity()], trackLocalhost: true })

    client.identify("ada@example.com")

    expect(warnings()).toContain("[mirafive] identify(): the id looks like an email")
  })
})

describe("reset()", () => {
  it("forgets the user, the ids and the session", async () => {
    const client = await full()

    client.consent(true)
    client.identify("u_1")
    const before = client.anonymousId()

    client.reset()
    client.track("a")
    await client.flush()

    const after = events().find((event) => event.name === "a")

    expect(after?.userId).toBeUndefined()
    expect(after?.anonymousId).toMatch(UUID)
    expect(after?.anonymousId).not.toBe(before)
  })
})

describe("opt-outs", () => {
  it("returns no anonymous id and stores nothing under Global Privacy Control", async () => {
    define(navigator, "globalPrivacyControl", true)
    const client = await full()

    client.consent(true)
    client.track("a")
    await client.flush()

    expect(client.anonymousId()).toBeUndefined()
    expect(requests).toHaveLength(0)
    expect(localStorage.length).toBe(0)
  })
})

describe("misuse", () => {
  it('does nothing in mode "consentless" and warns in development', async () => {
    setUrl("http://localhost:3000/")
    const client = await mira({ plugins: [identity()], trackLocalhost: true })

    client.consent(true)
    client.track("a")
    await client.flush()

    expect(batches()[0]?.mode).toBe("consentless")
    expect(localStorage.length).toBe(0)
    expect(warnings()).toContain('[mirafive] identity() needs mode "full"')
  })
})

describe("review fixes", () => {
  it("does not restore ids another tab removed", async () => {
    const client = await full()

    client.consent(true)
    client.track("a")
    localStorage.clear()
    client.track("b")
    await client.flush()

    const [a, b] = events().filter((event) => event.name !== "$pageview")

    expect(b?.anonymousId).toMatch(UUID)
    expect(b?.anonymousId).not.toBe(a?.anonymousId)
  })

  it("notices a user switch recorded by another tab", async () => {
    const client = await full()

    client.consent(true)
    client.identify("u_1")
    const before = client.anonymousId()

    localStorage.setItem(`mirafive:${NS}:uid`, `someone-else.${Date.now()}`)
    client.identify("u_1")

    expect(client.anonymousId()).not.toBe(before)
  })

  it("coerces a numeric user id and refuses empty ones", async () => {
    setUrl("http://localhost:3000/")
    const client = await mira({ mode: "full", plugins: [identity()], trackLocalhost: true })

    client.consent(true)
    client.identify(42 as unknown as string)
    client.identify("")
    client.identify(null as unknown as string)
    client.identify("  ")
    await client.flush()

    expect(events().map((event) => [event.name, event.userId])).toEqual([["$identify", "42"]])
    expect(warnings()).toContain("[mirafive] identify() needs a user id of 1–256 characters")
  })
})
