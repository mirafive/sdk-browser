# @mirafive/sdk-browser

The browser SDK of MIRA FIVE: privacy-first analytics for
websites and web apps, hosted in the EU, with one small import per feature.

## Size

| Import | min + gzip |
|---|---|
| `@mirafive/sdk-browser` (`createMira`) | 2.48 kB |
| `…` + `@mirafive/sdk-browser/pageviews` | 2.76 kB |
| `@mirafive/sdk-browser/identity` | 1.13 kB |
| `@mirafive/sdk-browser/autocapture` | 0.86 kB |
| `@mirafive/sdk-browser/search` | 0.40 kB |
| everything together | 4.60 kB |

What you do not import is not shipped (`sideEffects: false`, one entry per feature).
A consentless site with automatic pageviews ships 2.76 kB. Each plugin row is measured
on its own, as a bundler adds it to a page that already has the core.

## Install

```sh
npm install @mirafive/sdk-browser
# or: bun add / pnpm add / yarn add
```

No dependencies. ES2022 browsers (every evergreen browser; Safari ≥ 15.4). ESM only.

## Quickstart

```ts
import { createMira } from "@mirafive/sdk-browser"
import { pageviews } from "@mirafive/sdk-browser/pageviews"

const mira = createMira({
  key: import.meta.env.VITE_MIRAFIVE_KEY, // the source's website key, mf_…
  plugins: [pageviews()]
})

mira.track("signup", { plan: "pro" })
```

Verify it: open the site (not `localhost`, or pass `trackLocalhost: true`), then look
for `POST https://events.mirafive.io/v1/batch/mf_…` in the browser's network tab
answering `202` with `"accepted": 1`, and for the pageview in the source's live view in
MIRA FIVE.

## Consent & privacy

- **Default mode: `consentless`.** Identifier-free and needs no consent banner: no
  cookies, no storage, no ids, and the SDK never reads the browser's language, time
  zone or screen size (the tests spy on every one of them). A batch carries the SDK
  name, the page (URL with only campaign and click-id parameters, title, referrer) and
  your event properties.
- **`mode: "full"`** adds an anonymous id, a session id, your user id, and locale, time
  zone and screen size, and unlocks site search. It
  needs `identity()` and a consent answer; before the answer nothing is sent or stored.
  Put it behind your consent management platform (CMP).
- Pass the answer with `mira.consent(…)`:
  - `consent(true)`: statistics only.
  - `consent({ statistics })`: statistics is the only purpose; a key you leave
    out keeps its last answer. The `experiments` and `targeting` keys from older
    integrations are accepted and ignored; neither counts as consent.
  - `consent(false)`: forgets the ids and the user, clears the queue.
  - Events before statistics consent are dropped, `$identify` included: call
    `identify()` again after the grant (the user id is kept in memory and stamped on
    later events, but the `$identify` event itself is not replayed).
  - A CMP that knows the stored answer before the SDK loads sets
    `window.__mirafive_consent = { statistics }` (or `false`)
    first; the SDK applies it at start, so the landing pageview is counted with the
    answer (`$boot: 1`).
- The landing pageview is sent when consent is first granted, so a visitor who accepts
  on the first page still counts that page.
- Do Not Track, Global Privacy Control, `window.__mirafive_ignore = true` (for the site
  owner's own visits) and prerendering send nothing; a prerendered page sends once it
  is shown. `localhost`, `127.*`, `[::1]`, `*.local` and `file:` send nothing unless
  `trackLocalhost: true`.
- Full mode stores, in `localStorage` only (never cookies), `mirafive:{namespace}:aid`
  (anonymous id, 365 days since last seen), `:sid` (session, 30 minutes idle) and
  `:uid` (a hash of the user id, to notice a different person signing in). The
  namespace is the key without its last `_…` part.

Wiring common CMPs (statistics is the usual "analytics" category):

```ts
// Cookiebot
window.addEventListener("CookiebotOnConsentReady", () => {
  const { statistics } = Cookiebot.consent
  mira.consent({ statistics })
})

// OneTrust (default group id: C0002 performance)
window.OptanonWrapper = () => {
  const groups = window.OnetrustActiveGroups ?? ""
  mira.consent({ statistics: groups.includes(",C0002,") })
}

// Any CMP with a callback
myCmp.onChange((choices) => mira.consent({ statistics: choices.analytics }))
```

## API reference

```ts
import { createMira } from "@mirafive/sdk-browser"
import type { Mira, MiraCore, MiraOptions, Plugin, ConsentAnswer } from "@mirafive/sdk-browser"
import { pageviews } from "@mirafive/sdk-browser/pageviews"
import { identity } from "@mirafive/sdk-browser/identity" // required for mode "full"
import { autocapture } from "@mirafive/sdk-browser/autocapture"
import { siteSearch } from "@mirafive/sdk-browser/search"
```

`createMira<Events>(options): Mira<Events>`

| Option | Default | |
|---|---|---|
| `key` | required | the source's website key |
| `host` | `https://events.mirafive.io` | must have a scheme |
| `mode` | `"consentless"` | `"full"` needs `identity()` |
| `plugins` | `[]` | |
| `flushAt` | `20` | send once this many events are queued, 1–1000 (each batch also stays under ~48 KB) |
| `flushAfterMs` | `5000` | send this long after the first queued event, 50–300000 |
| `trackLocalhost` | `false` | |

`createMira` throws a `TypeError` for a `secretKey` option (secret keys are
server-only), a host without a scheme, and `mode: "full"` without `identity()`.
Nothing else throws; transport problems are dropped with a warning in development.

| Member | Plugin | |
|---|---|---|
| `track(name, properties?)` | core | queue an event; names starting with `$` are reserved |
| `pageview(page?: { url?, title?, referrer? } \| null)` | core | queue `$pageview` for the current or given page |
| `flush(): Promise<void>` | core | send now |
| `use(plugin)` | core | add a plugin after creation |
| `destroy()` | core | stop timers and listeners, undo patches, drop the queue |
| `consent(answer: boolean \| { statistics? })` | identity | see above; `experiments` and `targeting` keys are accepted and ignored |
| `identify(userId, traits?)` | identity | `$identify`, then `userId` on later events; a different user starts fresh ids; ids are 1–256 characters (numbers are turned into strings) |
| `reset()` | identity | forget ids, user and session |
| `anonymousId(): string \| undefined` | identity | for linking server-side events; `undefined` without statistics consent |
| `search(query)` | search | queue `$search` |

A member whose plugin is missing warns once in development and does nothing.

Typed events are types only:

```ts
const mira = createMira<{ signup: { plan: string }; logout: undefined }>({ key })
mira.track("signup", { plan: "pro" }) // checked
```

Plugins:

- `pageviews({ hash?, initial? })`: the landing pageview (a microtask after creation,
  unless `initial: false`) and every same-document navigation, for any SPA router:
  the Navigation API's `navigatesuccess`, else patched `pushState`/`replaceState` and
  `popstate`; `hashchange` and the fragment only with `hash: true`. The title is read
  one macrotask after a navigation. The same path and query twice is one view. After
  the first view the referrer is the previous page.
- `identity()`: consent, ids and the user (mode `"full"`).
- `autocapture({ selectorAttributes? })`: `$autocapture` for clicks, submits and
  changes on `a, button, input, select, textarea` and elements with a button, link, tab
  or menuitem role: tag, a short selector, id and classes (generated names skipped),
  the label text of links and buttons, the cleaned `href`, `name`, `type`, and
  `data-testid`/`data-test`/`data-cy`/`data-qa`/`data-track` plus your
  `selectorAttributes`. Never what was typed; nothing for password, email or hidden
  inputs or under `[data-mira-no-capture]`. Works in both modes.
- `siteSearch({ parameters? })`: `$search` from `q`, `s`, `search` or `query` in the
  page URL (read before cleaning), sent after 1 s without a change, or when the visitor
  moves on or leaves; plus `mira.search(query)`. Mode `"full"`, after consent.

## Writing a plugin

A plugin is `{ name, setup(core) }`; `setup` may return a teardown that `destroy()`
runs. Plugins given to `createMira` are set up in order during creation; `use()` sets
one up at any later time, so the tracker can load a feature chunk when it is needed.

```ts
import type { Plugin } from "@mirafive/sdk-browser"

export const outboundLinks = (): Plugin => ({
  name: "outbound-links",
  setup(core) {
    const onClick = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest("a")

      if (link && link.host !== location.host) {
        core.send("outbound link", { host: link.host }, { url: core.clean(location.href) })
      }
    }

    document.addEventListener("click", onClick, true)
    core.expose({ outbound: (host: string) => core.send("outbound link", { host }) })

    return () => document.removeEventListener("click", onClick, true)
  }
})
```

`MiraCore`, the surface a plugin gets:

| Member | |
|---|---|
| `options` | the options as given, `host` and `mode` resolved |
| `state` | shared state (below); plugins write only the parts they own |
| `client` | the `Mira` the site holds |
| `send(name, properties?, page?)` | queue an event; opt-outs, the full-mode gate and `beforeSend` apply |
| `expose(methods)` | put methods on the client, replacing stubs of the same name |
| `on(hook, listener): () => void` | subscribe to a hook |
| `emit(hook, argument?)` | run a hook; `false` when a listener returned `false` |
| `ready(run)` | run in a microtask: after every plugin given at creation is set up |
| `flush(unload?)`, `clear()` | send the queue; empty it, the hold buffer and pending retries |
| `hold()`, `release(keep)` | hold events while waiting for identity (below) |
| `clean(url)` | the URL cleaned as pageviews are |
| `cut(text, max)` | cut text without splitting a surrogate pair (use it for every cut) |
| `uuid()`, `warn(message)`, `optedOut()` | a v4 UUID; a development warning (once); DNT, GPC, ignore or prerendering |

| Hook | Argument | When |
|---|---|---|
| `beforeSend` | the event, change it in place; return `false` to drop it | as each event is queued |
| `pageview` | the page URL before cleaning | after each pageview |
| `consent` | the consent answer | after each answer (identity) |
| `user` | none | after `identify()` and `reset()` (identity) |
| `flush` | none | before each flush, including the one on page hide |

| `state` | Owner | |
|---|---|---|
| `mode` | identity | the mode batches are sent in: `"full"` only while statistics consent holds |
| `context` | core | sent with every batch; framework packages leave `sdk` unchanged (the hosted tracker sets its own name) |
| `hash` | pageviews | hash routing |
| `page` | core | the last pageview's page, sent or not |
| `dropped` | core | the last pageview dropped for want of consent (never a held one); identity resends it on the grant |
| `consent`, `boot`, `user`, `aid()` | identity | the answer, `$boot`, the user, the anonymous id (minted on first use, only with a consent scope) |

In mode `"full"` the core sends nothing until `state.mode` is `"full"`, whichever
plugins are present. `createMira` checks for a plugin *named* `"identity"`: a loader
that fetches identity later passes a placeholder `{ name: "identity", setup() {} }` and
calls `use(identity())` when the chunk arrives; the landing pageview is then resent on
the first grant and a pre-set `window.__mirafive_consent` still counts as `$boot: 1`.

Between a consent grant and identity arriving, call `core.hold()`: events (pageviews,
autocapture, `track`) are then kept in a buffer of at most 100 instead of dropped.
identity releases the buffer when it applies an answer: with statistics consent the
events are queued with their original times and the new ids; otherwise they are
dropped. Only the page viewed before holding began is resent, so a navigation during the
hold, or a landing pageview that was itself held, counts once. `core.release(keep)`
ends holding by hand. Without `hold()` events before the
grant are dropped as usual (the landing pageview is resent either way).

## Framework / runtime notes

- Create one client per page, in the browser only (not during SSR). A second
  `createMira` while one is running stays inert and warns in development; `destroy()`
  releases the page, so React StrictMode's mount, unmount and mount works.
- For React, Next.js, Vue, Nuxt, Astro and TanStack use the MIRA FIVE framework
  packages (`@mirafive/sdk-react`, …); they wrap this client.
- CSP: `connect-src https://events.mirafive.io` (or your `host`).
- Batches are `text/plain` POSTs (no CORS preflight); on page hide they go by
  `navigator.sendBeacon`, else `fetch` with `keepalive`; a batch still in flight is sent
  again by beacon (its batch id makes the copy count once). A failed send is tried up to
  three times in all, with backoff, honouring `Retry-After` up to 10 s.
- An event the server would refuse is dropped on its own (a development warning names
  it) so it cannot take the batch down: properties over 32 KB of UTF-8 JSON, over 64
  leaf values (a list or an empty object counts as one), deeper than 5 levels, a key
  over 128 characters, or a string with a lone surrogate. Page URL, title and referrer
  are cut to 2048 / 512 / 2048 characters without splitting a character.
- Insecure contexts (plain `http`) work: ids come from `crypto.getRandomValues` there.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Nothing arrives | On `localhost` pass `trackLocalhost: true`; check Do Not Track, Global Privacy Control and `__mirafive_ignore`; in mode `"full"`, `consent(true)` must have run; check `host`. |
| `403 secret_key_in_path` / `website_key_as_bearer` | You passed a secret key. Use the website key (`mf_…` of a website source). |
| `403 origin_not_allowed` | Add the site's origin to the source's allowed origins in MIRA FIVE. |
| `400 collection_mode_not_allowed` | `mode: "full"` on a consentless source: switch the source to full or drop `mode`. |

## For AI agents

Copy-paste setup prompt:

```text
Add MIRA FIVE analytics to this site with @mirafive/sdk-browser.
1. Install @mirafive/sdk-browser with the project's package manager.
2. Put the source's website key in the public env var of this framework
   (VITE_MIRAFIVE_KEY, NEXT_PUBLIC_MIRAFIVE_KEY, PUBLIC_MIRAFIVE_KEY or
   NUXT_PUBLIC_MIRAFIVE_KEY). Never use MIRAFIVE_SECRET_KEY in browser code.
3. In the client entry (runs once, browser only), add:
     import { createMira } from "@mirafive/sdk-browser"
     import { pageviews } from "@mirafive/sdk-browser/pageviews"
     export const mira = createMira({ key: <the env var>, plugins: [pageviews()] })
   Add autocapture() from "@mirafive/sdk-browser/autocapture" if clicks should be counted.
4. Keep the default consentless mode: it needs no banner. Only if the site already has a
   consent manager and wants ids: add identity() from "@mirafive/sdk-browser/identity",
   pass mode: "full", and call mira.consent({ statistics }) from
   the consent manager's callback.
5. Verify: load a page (not localhost, or pass trackLocalhost: true) and check the network
   tab for POST https://events.mirafive.io/v1/batch/<key> answering 202; report what you
   changed.
Do not add other analytics libraries, cookies or consent banners.
```

Facts for agents:

- Imports: `import { createMira } from "@mirafive/sdk-browser"`; plugins from
  `@mirafive/sdk-browser/pageviews`, `/identity`, `/autocapture`, `/search` (named
  exports `pageviews`, `identity`, `autocapture`, `siteSearch`). There is no default export.
- The only key is the source's public **website key**, passed as `key`. Env vars:
  `VITE_MIRAFIVE_KEY`, `NEXT_PUBLIC_MIRAFIVE_KEY`, `PUBLIC_MIRAFIVE_KEY`,
  `NUXT_PUBLIC_MIRAFIVE_KEY`. A custom host goes in the `host` option; browser code
  cannot read server env vars such as `MIRAFIVE_HOST`.
- Never ship `MIRAFIVE_SECRET_KEY` to a browser; passing `secretKey` throws, and a
  secret key in a URL is refused and marked exposed.
- `mode: "full"` requires `identity()` in `plugins` (else `createMira` throws) and a
  `consent(...)` call (else nothing is sent). Consentless mode needs neither.
- `siteSearch()` works in mode `"full"` only.
- Nothing throws for transport reasons; failures are dropped with a
  `[mirafive] …` console warning on local hosts only.
- Verify an install: the network tab shows `POST …/v1/batch/{key}` with a `text/plain`
  body and a `202` answer `{ "accepted": n, "dropped": 0 }`; the event then appears in
  the source's live view in MIRA FIVE.
- Wire contract: [mirafive/protocol](https://github.com/mirafive/protocol).

## License

[MIT](LICENSE) © 2026 Cloo GmbH
