import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { experiments } from "../src/experiments.ts"
import { flags } from "../src/flags.ts"
import { identity } from "../src/identity.ts"
import type { SnippetEntry } from "../src/protocol/types.ts"
import { NS, events, json, mira, route, setUrl, tick, w } from "./helpers.ts"

interface SnippetCase {
  name: string
  snippet: string
  url: string
  storage?: Record<string, string>
  pending?: string
  now: number
  expect: { entry: SnippetEntry | null; pending: string | null }
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/page-snippet.cases.json"), "utf8")
) as {
  snippets: Record<string, { ingestKey: string }>
  cases: SnippetCase[]
}

const NOW = 1_727_430_000_000
const entry = (variant: string, key = "hero"): SnippetEntry => ({
  k: key,
  v: variant,
  s: "k3j9x0a1b2c3",
  w: [5000, 5000],
  m: "o",
  h: "8624a0de",
  b: 1
})

const exposures = () =>
  events()
    .filter((event) => event.name === "$exposure")
    .map((event) => event.properties)

const serveFlags = (orig: string[] = []) =>
  route((request) =>
    request.url.includes("/v1/flags/") ? json({ v: 1, at: NOW, flags: {}, orig }) : undefined
  )

const start = () => mira({ mode: "full", plugins: [identity(), flags(), experiments()] })

describe("experiments()", () => {
  it("sends $exposure with $boot and $snippet when the recomputed draw matches", async () => {
    localStorage.setItem(`mirafive:${NS}:aid`, "0199a3f2-7c1e-7a4b-9f00-000000000005.1727000000000")
    w.__mirafive_consent = { statistics: true, experiments: true }
    w.__mirafive_experiments = [entry("b")]
    serveFlags()
    const client = await start()

    await tick()
    await client.flush()

    expect(exposures()).toEqual([{ $experiment: "hero", $variant: "b", $boot: 1, $snippet: "8624a0de" }])
    expect(events()[0]?.anonymousId).toBe("0199a3f2-7c1e-7a4b-9f00-000000000005")
  })

  it("sends nothing when the draw on the counted id differs", async () => {
    localStorage.setItem(`mirafive:${NS}:aid`, "0199a3f2-7c1e-7a4b-9f00-000000000005.1727000000000")
    w.__mirafive_consent = { statistics: true, experiments: true }
    w.__mirafive_experiments = [entry("a")]
    serveFlags()
    const client = await start()

    await tick()
    await client.flush()

    expect(exposures()).toEqual([])
  })

  it("adopts the pending id on consent and counts under it", async () => {
    w.__mirafive_aid_next = "0199a3f2-7c1e-7a4b-9f00-000000000003"
    w.__mirafive_experiments = [{ ...entry("b"), m: "r", h: "fa1adf55", b: 0 }]
    serveFlags()
    const client = await start()

    await tick()
    await client.flush()
    expect(exposures()).toEqual([])

    client.consent({ statistics: true, experiments: true })
    await client.flush()

    expect(exposures()).toEqual([{ $experiment: "hero", $variant: "b", $boot: 0, $snippet: "fa1adf55" }])
    expect(client.anonymousId()).toBe("0199a3f2-7c1e-7a4b-9f00-000000000003")
  })

  it("waits for the flag document, and skips experiments in its orig", async () => {
    localStorage.setItem(`mirafive:${NS}:aid`, "0199a3f2-7c1e-7a4b-9f00-000000000005.1727000000000")
    w.__mirafive_consent = { statistics: true, experiments: true }
    w.__mirafive_experiments = [entry("b")]
    const answer = Promise.withResolvers<Response>()

    route((request) => (request.url.includes("/v1/flags/") ? answer.promise : undefined))
    const client = await start()

    await tick()
    await client.flush()
    expect(exposures()).toEqual([])

    answer.resolve(json({ v: 1, at: NOW, flags: {}, orig: ["hero"] }))
    await tick()
    await client.flush()

    expect(exposures()).toEqual([])
  })

  it("needs the experiments scope and statistics", async () => {
    localStorage.setItem(`mirafive:${NS}:aid`, "0199a3f2-7c1e-7a4b-9f00-000000000005.1727000000000")
    w.__mirafive_consent = { statistics: true }
    w.__mirafive_experiments = [entry("b")]
    serveFlags()
    const client = await start()

    await tick()
    await client.flush()
    expect(exposures()).toEqual([])

    client.consent({ experiments: true })
    await client.flush()
    expect(exposures()).toHaveLength(1)
  })

  it("handles entries pushed later, once each", async () => {
    localStorage.setItem(`mirafive:${NS}:aid`, "0199a3f2-7c1e-7a4b-9f00-000000000005.1727000000000")
    w.__mirafive_consent = { statistics: true, experiments: true }
    serveFlags()
    const client = await start()

    await tick()
    w.__mirafive_experiments?.push(entry("b"))
    w.__mirafive_experiments?.push(entry("b"))
    ;(w.__mirafive_experiments = w.__mirafive_experiments || []).push(entry("b", "banner"))
    await client.flush()

    expect(exposures().map((properties) => properties?.["$experiment"])).toEqual(["hero", "banner"])
  })

  it("restores the array's push on destroy", async () => {
    const list: SnippetEntry[] = []
    const { push } = list

    w.__mirafive_experiments = list
    const client = await start()

    expect(list.push).not.toBe(push)
    client.destroy()
    expect(list.push).toBe(push)
  })
})

describe("agrees with the page snippet (fixtures/page-snippet.cases.json)", () => {
  // The first case drew on a pending id while a valid id was stored; the SDK counts under the stored id.
  const cases = fixture.cases.filter((item) => item.expect.entry && item.name !== fixture.cases[0]?.name)

  it.each(cases.map((item) => [item.name, item] as const))("%s", async (_, item) => {
    vi.setSystemTime(item.now)
    setUrl(item.url.replace("example.com", "shop.example"))

    for (const [key, value] of Object.entries(item.storage ?? {})) {
      localStorage.setItem(key, value)
    }

    w.__mirafive_aid_next = item.expect.pending ?? undefined
    w.__mirafive_consent = { statistics: true, experiments: true }
    w.__mirafive_experiments = [item.expect.entry as SnippetEntry]
    route((request) =>
      request.url.includes("/v1/flags/") ? json({ v: 1, at: item.now, flags: {} }) : undefined
    )
    const key = fixture.snippets[item.snippet]?.ingestKey ?? ""
    const client = await mira({ key, mode: "full", plugins: [identity(), flags(), experiments()] })

    await tick()
    await client.flush()

    expect(exposures()).toEqual([
      {
        $experiment: item.expect.entry?.k,
        $variant: item.expect.entry?.v,
        $boot: item.expect.entry?.b,
        $snippet: item.expect.entry?.h
      }
    ])
  })
})
