import { cleanUrl } from "./protocol/clean-url.ts"
import { DEFAULT_HOST } from "./protocol/limits.ts"
import type {
  Doc,
  EventMap,
  Globals,
  Mira,
  MiraCore,
  MiraEvent,
  MiraOptions,
  MiraState,
  Page,
  Plugin,
  Properties
} from "./types.ts"
import { VERSION } from "./version.ts"

export type {
  ConsentAnswer,
  EventMap,
  FlagBootstrap,
  FlagState,
  Json,
  Mira,
  MiraCore,
  MiraEvent,
  MiraHooks,
  MiraOptions,
  MiraState,
  Mode,
  Page,
  Plugin,
  Properties
} from "./types.ts"

type Listener = (argument?: unknown) => unknown

const warned = new Set<string>()

const uuid = (): string =>
  crypto.randomUUID?.() ??
  // Insecure contexts (plain http) have no randomUUID.
  "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (digit) =>
    (+digit ^ ((crypto.getRandomValues(new Uint8Array(1))[0] ?? 0) & (15 >> (+digit / 4)))).toString(16)
  )

const check = (ok: unknown, message: string): void => {
  if (!ok) {
    throw new TypeError("[mirafive] " + message)
  }
}

export const createMira = <Events extends EventMap = EventMap>(options: MiraOptions): Mira<Events> => {
  const w = window as Window & Globals
  const d: Doc = document
  const n = navigator as Navigator & { globalPrivacyControl?: boolean }
  const l = location
  const local = l.protocol === "file:" || /^(localhost|\[::1\]|127\..*|.*\.local)$/.test(l.hostname)
  const { key, mode = "consentless", plugins = [], flushAt = 20, flushAfterMs = 5000 } = options
  const host = (options.host ?? DEFAULT_HOST).replace(/\/+$/, "")
  const hooks: Record<string, Set<Listener>> = {}
  const teardowns: (() => void)[] = []
  const state: MiraState = { mode: "consentless", context: { sdk: "mirafive-browser/" + VERSION } }
  let queue: MiraEvent[] = []
  let bytes = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let inert = !!w.__mirafive_boot

  check(!("secretKey" in options), "secret keys are server-only")
  check(/^https?:\/\/./.test(host), "host needs a scheme")
  check(
    mode !== "full" || plugins.some((plugin) => plugin.name === "identity"),
    'mode "full" needs identity()'
  )

  const warn = (message: string): void => {
    if (local && !warned.has(message)) {
      warned.add(message)
      // oxlint-disable-next-line no-console
      console.warn("[mirafive] " + message)
    }
  }

  const emit = (hook: string, argument?: unknown): boolean => {
    let kept = true

    hooks[hook]?.forEach((listener) => {
      kept = listener(argument) !== false && kept
    })

    return kept
  }

  const optedOut = (): boolean =>
    n.doNotTrack === "1" || !!(n.globalPrivacyControl || w.__mirafive_ignore || d.prerendering)

  const clean = (url: string): string => cleanUrl(url, state.hash)

  // Retries resend the identical body: the batch id in it makes the server store it once.
  const post = async (url: string, body: string, keepalive: boolean, attempt = 0): Promise<void> => {
    let response: Response | undefined

    try {
      response = await fetch(url, { method: "POST", body, credentials: "omit", keepalive })

      const { status } = response

      if (status !== 408 && status !== 429 && status < 500) {
        const answer: { reason?: string; code?: string } = await response.json().catch(() => ({}))

        return void (
          (answer.reason || !response.ok) &&
          warn(`batch: ${answer.reason ?? answer.code ?? status}`)
        )
      }
    } catch {
      // A network error is retried like a 5xx.
    }

    if (attempt > 1) {
      return warn("batch dropped")
    }

    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.min(
          +(response?.headers.get("retry-after") ?? 0) * 1e3 || Math.random() * 300 * 2 ** attempt,
          1e4
        )
      )
    )

    return post(url, body, keepalive, attempt + 1)
  }

  const flush = async (unload?: boolean): Promise<void> => {
    emit("flush")
    clearTimeout(timer)
    timer = undefined

    if (queue.length) {
      const url = `${host}/v1/batch/${key}`
      const body = JSON.stringify({
        v: 1,
        batch: uuid(),
        mode: state.mode,
        sentAt: Date.now(),
        context: state.context,
        events: queue
      })

      queue = []
      bytes = 0

      if (!(unload && n.sendBeacon?.(url, body))) {
        await post(url, body, !!unload)
      }
    }
  }

  const send = (name: string, properties?: Properties, page?: Page): void => {
    if (d.prerendering) {
      // Sent when the page is shown, or never.
      return d.addEventListener("prerenderingchange", () => send(name, properties, page), { once: true })
    }

    if (inert || optedOut() || (mode === "full" && state.mode !== "full")) {
      return
    }

    if (local && !options.trackLocalhost) {
      return warn("local host: set trackLocalhost")
    }

    const event: MiraEvent = { name, time: Date.now(), page, properties }

    if (emit("beforeSend", event)) {
      const size = new Blob([JSON.stringify(event)]).size

      // Keeps every batch, the one sent on page hide included, under ~48 KB.
      if (bytes + size > 48e3) {
        void flush()
      }

      queue.push(event)
      bytes += size

      if (queue.length >= flushAt) {
        void flush()
      } else {
        timer ??= setTimeout(() => void flush(), flushAfterMs)
      }
    }
  }

  const onHide = (event: Event): void => {
    if (event.type === "pagehide" || d.visibilityState === "hidden") {
      void flush(true)
    }
  }

  const use = (plugin: Plugin): void => {
    const teardown = inert || plugin.setup(core)

    if (typeof teardown === "function") {
      teardowns.push(teardown)
    }
  }

  const client: Record<string, (...args: never[]) => unknown> = {
    track: (name: string, properties?: Properties) =>
      /^[^$\s](.{0,126}\S)?$/s.test(name)
        ? send(name, properties, { url: clean(l.href) })
        : warn("bad name: " + name),
    pageview: (given: Page = {}) => {
      const href = given.url ?? l.href
      const page = {
        url: clean(href).slice(0, 2048),
        title: (given.title ?? d.title).slice(0, 512) || undefined,
        referrer: (given.referrer ?? state.page?.url ?? d.referrer).slice(0, 2048) || undefined
      }

      state.page = page
      send("$pageview", undefined, page)
      emit("pageview", href)
    },
    flush: () => flush(),
    use,
    destroy: () => {
      if (!inert) {
        inert = true
        w.__mirafive_boot = undefined
        clearTimeout(timer)
        queue = []
        d.removeEventListener("visibilitychange", onHide)
        w.removeEventListener("pagehide", onHide)
        teardowns.forEach((teardown) => teardown())
      }
    }
  }

  for (const name of "consent identify reset anonymousId search flag config onFlags setFlagProperties".split(
    " "
  )) {
    client[name] = (...args: unknown[]) => (
      warn(name + "() needs its plugin"),
      name === "onFlags" ? () => {} : args[1]
    )
  }

  const core: MiraCore = {
    options: { ...options, host, mode },
    state,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the stubs above complete the client
    client: client as unknown as Mira,
    send,
    expose: (added) => void Object.assign(client, added),
    /* oxlint-disable typescript/no-unsafe-type-assertion -- hooks are typed at the MiraCore boundary */
    on: ((hook: string, listener: Listener) => {
      const set = (hooks[hook] ??= new Set())

      set.add(listener)

      return () => set.delete(listener)
    }) as MiraCore["on"],
    /* oxlint-enable typescript/no-unsafe-type-assertion */
    emit,
    ready: (run) => queueMicrotask(run),
    flush,
    clear: () => {
      queue = []
      bytes = 0
    },
    clean,
    uuid,
    warn,
    optedOut
  }

  if (inert) {
    warn("second client stays inert")
  } else {
    w.__mirafive_boot = 1
    d.addEventListener("visibilitychange", onHide)
    // Safari's back/forward cache can freeze a page it never reports hidden.
    w.addEventListener("pagehide", onHide)
    plugins.forEach(use)
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see core.client
  return client as unknown as Mira<Events>
}
