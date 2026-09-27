import { readFileSync } from "node:fs"
import { join } from "node:path"

import { Ajv2020 } from "ajv/dist/2020.js"
import { afterEach, beforeEach, expect, vi } from "vitest"

import type * as Core from "../src/index.ts"
import type { Mira, MiraOptions } from "../src/index.ts"
import type { Batch } from "../src/protocol/types.ts"
import type { Globals } from "../src/types.ts"

export const KEY = "mf_ab12cd34_0123456789abcdefghijklmnop"
export const NS = "mf_ab12cd34"
export const HOST = "https://events.mirafive.io"

const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/batch.schema.json"), "utf8")) as object
)

export interface Request {
  url: string
  via: "fetch" | "beacon"
  method: string
  body: string
  init?: RequestInit | undefined
}

export type Route = (request: Request) => Response | Promise<Response> | undefined

/** Every request the SDK made, in order. */
export const requests: Request[] = []
const routes: Route[] = []
const invalid: unknown[] = []
const clients: Mira[] = []

export const w = window as unknown as Window &
  Globals &
  Record<string, unknown> & { happyDOM: { setURL(url: string): void } }

/** Answers matching requests first; an unmatched batch gets a 202 receipt, anything else a 404. */
export const route = (handler: Route): void => {
  routes.unshift(handler)
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

export const beacon = vi.fn((url: string, body: string): boolean => {
  record({ url, via: "beacon", method: "POST", body })
  return true
})

const record = (request: Request): void => {
  requests.push(request)

  if (request.url.includes("/v1/batch/")) {
    const batch = JSON.parse(request.body) as unknown

    if (!validate(batch)) {
      invalid.push({ batch, errors: validate.errors })
    }
  }
}

export const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
  const request: Request = {
    url: String(input),
    via: "fetch",
    method: init?.method ?? "GET",
    body: typeof init?.body === "string" ? init.body : "",
    init
  }

  record(request)

  const answer = routes.map((handler) => handler(request)).find(Boolean)

  if (answer) {
    return answer
  }

  if (request.url.includes("/v1/batch/")) {
    const { batch, events } = JSON.parse(request.body) as Batch

    return json({ batch, accepted: events.length, dropped: 0 }, 202)
  }

  return json({ code: "not_found", detail: "No flags." }, 404)
})

/** The batches sent so far, parsed; each was checked against the protocol's batch schema. */
export const batches = (): Batch[] =>
  requests
    .filter((request) => request.url.includes("/v1/batch/"))
    .map((request) => JSON.parse(request.body) as Batch)

export const events = (): Batch["events"][number][] => batches().flatMap((batch) => batch.events)

export const names = (): string[] => events().map((event) => event.name)

export const setUrl = (url: string): void => w.happyDOM.setURL(url)

/** A fresh core module per call, so the once-per-message warnings start empty. */
export const load = async (): Promise<typeof Core> => {
  vi.resetModules()
  return import("../src/index.ts")
}

export const mira = async (options: Partial<MiraOptions> = {}): Promise<Mira> => {
  const { createMira } = await load()
  const client = createMira({ key: KEY, ...options })

  clients.push(client)
  return client
}

/** A synchronous factory, for tests that act right after creation (before the landing pageview's microtask). */
export const factory = async (): Promise<(options?: Partial<MiraOptions>) => Mira> => {
  const { createMira } = await load()

  return (options = {}) => {
    const client = createMira({ key: KEY, ...options })

    clients.push(client)
    return client
  }
}

/** Lets microtasks and zero-delay timers run, and any pending fetch settle. */
export const tick = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
}

export const define = <T extends object>(target: T, name: string, value: unknown): void => {
  Object.defineProperty(target, name, { value, configurable: true, writable: true })
}

export const warnings = (): string[] =>
  (console.warn as unknown as { mock: { calls: string[][] } }).mock.calls.map((call) => call[0] ?? "")

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
  vi.setSystemTime(1_727_430_000_000)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.stubGlobal("fetch", fetchMock)
  define(navigator, "sendBeacon", beacon)
  setUrl("https://shop.example/pricing?utm_source=news&secret=1")
  document.title = "Pricing"
})

afterEach(() => {
  expect(invalid.splice(0), "every batch matches the protocol schema").toEqual([])

  for (const client of clients.splice(0)) {
    client.destroy()
  }

  for (const name of Object.keys(w)) {
    if (name.startsWith("__mirafive")) {
      delete w[name]
    }
  }

  for (const name of ["doNotTrack", "globalPrivacyControl", "sendBeacon"]) {
    delete (navigator as unknown as Record<string, unknown>)[name]
  }

  delete (document as unknown as Record<string, unknown>)["prerendering"]
  delete (document as unknown as Record<string, unknown>)["referrer"]
  delete (document as unknown as Record<string, unknown>)["visibilityState"]
  delete (w as Record<string, unknown>)["navigation"]
  document.head.innerHTML = ""
  document.body.innerHTML = ""
  localStorage.clear()
  requests.length = 0
  routes.length = 0
  fetchMock.mockClear()
  beacon.mockClear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
