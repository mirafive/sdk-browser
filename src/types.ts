import type { Bootstrap, Flag, FlagValue, Json, Mode, SnippetEntry } from "./protocol/types.ts"

export type { Bootstrap as FlagBootstrap, Json, Mode }

export interface Page {
  url?: string | undefined
  title?: string | undefined
  referrer?: string | undefined
}

export type Properties = Record<string, unknown>

/** Event name → its properties. `undefined` in the union makes the properties optional. */
export type EventMap = Record<string, Properties | undefined>

/** A consent answer by scope. Scopes left out keep their last answer. */
export interface ConsentAnswer {
  statistics?: boolean
  experiments?: boolean
  targeting?: boolean
}

export interface MiraOptions {
  /** The source's public website key (`mf_…`). */
  key: string
  /** Default `https://events.mirafive.io`. */
  host?: string
  /** Default `"consentless"`. `"full"` needs the `identity()` plugin. */
  mode?: Mode
  plugins?: Plugin[]
  /** Send once this many events are queued. Default 20. */
  flushAt?: number
  /** Send this long after the first queued event. Default 5000. */
  flushAfterMs?: number
  /** Also send from `localhost`, `127.*`, `[::1]`, `*.local` and `file:`. */
  trackLocalhost?: boolean
}

export interface Mira<Events extends EventMap = EventMap> {
  track<Name extends keyof Events & string>(
    name: Name,
    ...properties: undefined extends Events[Name] ? [properties?: Events[Name]] : [properties: Events[Name]]
  ): void
  /** Queues `$pageview` for the current page, or the one given. */
  pageview(page?: Page | null): void
  flush(): Promise<void>
  use(plugin: Plugin): void
  destroy(): void
  /** identity: `true` is statistics only; `false` forgets everything local and clears the queue. */
  consent(answer: boolean | ConsentAnswer): void
  /** identity */
  identify(userId: string, traits?: Properties): void
  /** identity */
  reset(): void
  /** identity: `undefined` until statistics consent. */
  anonymousId(): string | undefined
  /** search */
  search(query: string): void
  /** flags: the variant, or `true`/`false` for on/off flags. */
  flag(key: string, fallback: string | boolean): string | boolean
  /** flags */
  config<T>(key: string, fallback: T): T
  /** flags: runs when flags load or change, at once if they already have. */
  onFlags(listener: () => void): () => void
  /** flags: facts for targeting rules, held in memory and never sent. */
  setFlagProperties(properties: Properties): void
}

/** An event as it sits in the queue. `beforeSend` hooks may change it. */
export interface MiraEvent {
  name: string
  time: number
  page?: Page | undefined
  properties?: Properties | undefined
  anonymousId?: string | undefined
  userId?: string | undefined
  sessionId?: string | undefined
}

/** What the flags plugin holds: a browser document, a values document or a bootstrap (FLAGS.md §3, §5.3). */
export interface FlagState {
  v?: number
  at: number
  flags?: Record<string, Flag>
  values?: Record<string, FlagValue | Bootstrap["values"][string]>
  orig?: readonly string[]
  browser?: readonly string[]
  unit?: string
}

/** Shared state. Plugins read it and write the parts they own. */
export interface MiraState {
  /** The mode batches are sent in now. identity switches it to `"full"` while statistics consent holds. */
  mode: Mode
  /** Sent with every batch. `sdk` is set by the core; framework packages leave it unchanged. */
  context: {
    sdk?: string | undefined
    locale?: string | undefined
    timezone?: string | undefined
    screen?: [number, number]
  }
  /** Hash routing: the fragment is part of the page (pageviews sets it). */
  hash?: boolean
  /** The last pageview's page, sent or not. */
  page?: Page
  /** The last pageview's page that mode "full" dropped for want of consent (not one held by `hold()`). */
  dropped?: Page | undefined
  /** The consent answer; `undefined` until one is given (identity). */
  consent?: ConsentAnswer
  /** `1` when the consent answer was known when the page first drew (identity). */
  boot?: 0 | 1
  /** The signed-in user (identity). */
  user?: { id: string; traits?: Properties | undefined } | undefined
  /** The stored anonymous id, minted if needed; `undefined` without a consent scope or under an opt-out (identity). */
  aid?: () => string | undefined
  /** The flag state once loaded (flags). */
  flags?: FlagState
}

export interface MiraHooks {
  /** Each event as it is queued. Change it in place; return `false` to drop it. */
  beforeSend: (event: MiraEvent) => boolean | void
  /** After each pageview, with the page URL before cleaning. */
  pageview: (href: string) => void
  /** After each consent answer (identity). */
  consent: (answer: ConsentAnswer) => void
  /** After identify() or reset() (identity). */
  user: () => void
  /** After flags load or change (flags). */
  flags: () => void
  /** Before each flush, including the one on page hide: queue what is pending now. */
  flush: () => void
}

/** The surface plugins build on. */
export interface MiraCore {
  /** The options as given, with `host` (no trailing slash) and `mode` resolved. */
  readonly options: Readonly<MiraOptions & { host: string; mode: Mode }>
  readonly state: MiraState
  /** The client the site holds. */
  readonly client: Mira
  /** Queues an event. Opt-outs, the full-mode gate and `beforeSend` hooks apply. */
  send(name: string, properties?: Properties, page?: Page): void
  /** Adds methods to the client, replacing the stubs (or earlier methods) of the same name. */
  expose(methods: Record<string, (...args: never[]) => unknown>): void
  on<Hook extends keyof MiraHooks>(hook: Hook, listener: MiraHooks[Hook]): () => void
  /** Runs a hook's listeners; `false` when one of them returned `false`. */
  emit<Hook extends keyof MiraHooks>(hook: Hook, ...argument: Parameters<MiraHooks[Hook]>): boolean
  /** Runs in a microtask: after every plugin given at creation is set up, or right after a late `use()`. */
  ready(run: () => void): void
  /** Sends the queue; `true` uses `sendBeacon`, as on page hide. */
  flush(unload?: boolean): Promise<void>
  /** Empties the queue and the hold buffer, and cancels batches waiting for a retry. */
  clear(): void
  /**
   * Holds events (at most 100) instead of dropping them while mode "full" waits for statistics consent:
   * for a loader that fetches identity() after a grant. identity() releases them when it applies an answer.
   */
  hold(): void
  /** Ends holding: `true` queues the held events (with their original times), `false` drops them. */
  release(keep: boolean): void
  /** The URL with only campaign and click-id parameters, the fragment only in hash mode. */
  clean(url: string): string
  /** Cuts text to `max` UTF-16 units without splitting a surrogate pair; empty becomes `undefined`. */
  cut(text: string | null | undefined, max: number): string | undefined
  uuid(): string
  /** Once per message, only in development (a local hostname). */
  warn(message: string): void
  /** Do Not Track, Global Privacy Control, `__mirafive_ignore` or prerendering. */
  optedOut(): boolean
}

export interface Plugin {
  name: string
  /** Returns an optional teardown, run by `destroy()`. */
  setup(core: MiraCore): void | (() => void)
}

export interface Globals {
  __mirafive_boot?: unknown
  __mirafive_consent?: false | ConsentAnswer
  __mirafive_ignore?: unknown
  __mirafive_aid_next?: string | undefined
  __mirafive_experiments?: SnippetEntry[]
  navigation?: EventTarget
}

export type Doc = Document & { prerendering?: boolean }
