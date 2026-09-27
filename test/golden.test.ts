import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { autocapture } from "../src/autocapture.ts"
import { experiments } from "../src/experiments.ts"
import { flags } from "../src/flags.ts"
import { identity } from "../src/identity.ts"
import { pageviews } from "../src/pageviews.ts"
import { siteSearch } from "../src/search.ts"
import { VERSION } from "../src/version.ts"
import { NS, define, json, mira, requests, route, tick, w } from "./helpers.ts"

// Copied unchanged from mirafive/protocol; a changed file must come from there.
const pinned: Record<string, string> = {
  "batch.schema.json": "94ef27603d6d79ae8c370599445743c699e8c04d322198734b05268782c6a192",
  "page-snippet.cases.json": "e3572e307b6df6983895ecc4146e8b3aa8c5ff4f3ea0b2dd0aad15cf694b5598"
}
const protocol: Record<string, string> = {
  "batch.schema.json": "schema",
  "page-snippet.cases.json": "fixtures"
}
const checkout = join(import.meta.dirname, "../../protocol")
const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex")

describe("fixtures", () => {
  it.each(Object.entries(pinned))("%s is the pinned copy", (name, hash) => {
    expect(sha256(join(import.meta.dirname, "fixtures", name))).toBe(hash)
  })

  it.skipIf(!existsSync(checkout)).each(Object.keys(pinned))("%s equals the protocol checkout", (name) => {
    expect(sha256(join(import.meta.dirname, "fixtures", name))).toBe(
      sha256(join(checkout, protocol[name] ?? "", name))
    )
  })

  it("VERSION matches package.json", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8")) as {
      version: string
    }

    expect(VERSION).toBe(pkg.version)
  })
})

/** Deterministic ids: every UUID the SDK mints comes from this counter. */
const fixIds = (): void => {
  let next = 0

  vi.spyOn(crypto, "randomUUID").mockImplementation(
    () =>
      `0192d4a8-7b1c-4e8a-9c1d-${String(++next).padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`
  )
}

const body = (): string => `${JSON.stringify(JSON.parse(requests.at(-1)?.body ?? "{}"), null, 2)}\n`

describe("golden batches (ingested by the app's contract test)", () => {
  it("consentless", async () => {
    fixIds()
    define(document, "referrer", "https://www.google.com/")
    document.body.innerHTML = `<main><div class="cart"><button class="primary" data-testid="buy">Jetzt kaufen</button></div></main>`
    const client = await mira({ plugins: [pageviews(), autocapture()] })

    await tick()
    vi.setSystemTime(1_727_430_004_000)
    history.pushState({}, "", "/checkout?utm_source=news&cart=81")
    document.title = "Kasse"
    await tick()
    vi.setSystemTime(1_727_430_012_000)
    document.querySelector("button")?.click()
    vi.setSystemTime(1_727_430_055_000)
    client.track("order completed", {
      revenue: 49.9,
      currency: "EUR",
      items: [{ sku: "tee-black", quantity: 2 }]
    })
    vi.setSystemTime(1_727_430_060_000)
    await client.flush()

    expect(requests).toHaveLength(1)
    await expect(body()).toMatchFileSnapshot("golden/consentless.json")
  })

  it("full", async () => {
    fixIds()
    define(navigator, "language", "de-DE")
    define(window, "screen", { width: 1512, height: 982 })
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
      () => ({ resolvedOptions: () => ({ timeZone: "Europe/Berlin" }) }) as Intl.DateTimeFormat
    )
    define(document, "referrer", "https://www.google.com/")
    localStorage.setItem(`mirafive:${NS}:aid`, "0199a3f2-7c1e-7a4b-9f00-000000000005.1727000000000")
    w.__mirafive_consent = { statistics: true, experiments: true, targeting: false }
    w.__mirafive_experiments = [
      { k: "hero", v: "b", s: "k3j9x0a1b2c3", w: [5000, 5000], m: "o", h: "8624a0de", b: 1 }
    ]
    route((request) =>
      request.url.includes("/v1/flags/") ? json({ v: 1, at: 1_727_430_000_000, flags: {} }) : undefined
    )
    document.body.innerHTML = `<main><div class="cart"><button class="primary" data-testid="buy">Jetzt kaufen</button></div></main>`
    const client = await mira({
      mode: "full",
      plugins: [pageviews(), identity(), autocapture(), siteSearch(), flags(), experiments()]
    })

    await tick()
    vi.setSystemTime(1_727_430_012_000)
    document.querySelector("button")?.click()
    vi.setSystemTime(1_727_430_030_000)
    client.identify("u_42", { plan: "pro" })
    vi.setSystemTime(1_727_430_041_000)
    client.search("gift card")
    vi.setSystemTime(1_727_430_055_000)
    client.track("order completed", {
      revenue: 49.9,
      currency: "EUR",
      items: [{ sku: "tee-black", quantity: 2 }]
    })
    vi.setSystemTime(1_727_430_060_000)
    await client.flush()

    expect(requests.filter((request) => request.url.includes("/v1/batch/"))).toHaveLength(1)
    await expect(body()).toMatchFileSnapshot("golden/full.json")
  })
})
