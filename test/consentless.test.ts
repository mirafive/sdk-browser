import { describe, expect, it, vi } from "vitest"

import { autocapture } from "../src/autocapture.ts"
import { flags } from "../src/flags.ts"
import { pageviews } from "../src/pageviews.ts"
import { batches, json, mira, route, tick } from "./helpers.ts"

describe("consentless mode", () => {
  it("never reads language, time zone or screen, and never touches storage or cookies", async () => {
    const touched: string[] = []
    const watch = (target: object, name: string): void => {
      const owner = name in target && !Object.hasOwn(target, name) ? Object.getPrototypeOf(target) : target
      const descriptor = Object.getOwnPropertyDescriptor(owner, name) ?? {
        value: (target as Record<string, unknown>)[name]
      }

      vi.spyOn(owner as Record<string, unknown>, name, "get").mockImplementation(function (this: unknown) {
        touched.push(name)
        return descriptor.get ? descriptor.get.call(this) : descriptor.value
      })
    }

    for (const name of ["language", "languages"]) {
      watch(navigator, name)
    }

    for (const name of ["screen", "localStorage", "sessionStorage"]) {
      watch(window, name)
    }

    const cookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")

    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: () => (touched.push("cookie"), cookie?.get?.call(document)),
      set: (value: string) => (touched.push("cookie"), cookie?.set?.call(document, value))
    })
    const zone = vi.spyOn(Intl, "DateTimeFormat")
    const resolved = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")

    route((request) =>
      request.url.includes("/v1/flags/")
        ? json({ v: 1, at: Date.now(), values: { beta: ["on"] } })
        : undefined
    )
    document.body.innerHTML = `<button>Buy</button>`
    const client = await mira({ plugins: [pageviews(), autocapture(), flags()] })

    await tick()
    history.pushState({}, "", "/checkout")
    await tick()
    document.querySelector("button")?.click()
    client.track("signup", { plan: "pro" })
    client.flag("beta", false)
    client.consent(true)
    client.identify("u_1")
    await client.flush()
    client.track("late")
    window.dispatchEvent(new Event("pagehide"))
    await tick(600_000)
    delete (document as unknown as Record<string, unknown>)["cookie"]

    expect(touched).toEqual([])
    expect(zone).not.toHaveBeenCalled()
    expect(resolved).not.toHaveBeenCalled()

    // The spies do see reads.
    void [navigator.language, screen.width, localStorage.length, sessionStorage.length]
    expect(touched).toEqual(["language", "screen", "localStorage", "sessionStorage"])
    expect(batches().length).toBeGreaterThan(0)

    for (const batch of batches()) {
      expect(batch.mode).toBe("consentless")
      expect(batch.context).toEqual({ sdk: "mirafive-browser/0.5.0" })

      for (const event of batch.events) {
        expect(
          Object.keys(event).filter((key) => !["name", "time", "page", "properties"].includes(key))
        ).toEqual([])
      }
    }
  })
})
