/// <reference lib="webworker" />
/* eslint-disable no-restricted-globals */

// This service worker can be customized!
// See https://developers.google.com/web/tools/workbox/modules
// for the list of available Workbox modules, or add any other
// code you'd like.
// You can also remove this file if you'd prefer not to use a
// service worker, and the Workbox build step will be skipped.

import { clientsClaim } from 'workbox-core'
import { ExpirationPlugin } from 'workbox-expiration'
import { precacheAndRoute, createHandlerBoundToURL } from 'workbox-precaching'
import { registerRoute } from 'workbox-routing'
import { CacheFirst, StaleWhileRevalidate } from 'workbox-strategies'

declare const self: ServiceWorkerGlobalScope

clientsClaim()

// Precache assets generated by your build process.
//
// Their URLs are injected into the __WB_MANIFEST during build (by workbox).
//
// This variable must be present somewhere in your service worker file,
// even if you decide not to use precaching. See https://cra.link/PWA.
//
// We don't want to precache i18n files so we filter them out
// (normally this should be configured in a webpack workbox plugin, but we don't
// have access to it in CRA) — this is because all users will use at most
// one or two languages, so there's no point fetching all of them. (They'll
// be cached as you load them.)
const manifest = self.__WB_MANIFEST.filter((entry) => {
  return !/locales\/[\w-]+json/.test(
    typeof entry === 'string' ? entry : entry.url,
  )
})

precacheAndRoute(manifest)

// Set up App Shell-style routing, so that all navigation requests
// are fulfilled with your index.html shell. Learn more at
// https://developer.chrome.com/docs/workbox/app-shell-model/
//
// below is copied verbatim from CRA@5
const fileExtensionRegexp = new RegExp('/[^/?]+\\.[^/]+$')
registerRoute(
  // Return false to exempt requests from being fulfilled by index.html.
  ({ request, url }: { request: Request; url: URL }) => {
    // If this isn't a navigation, skip.
    if (request.mode !== 'navigate') {
      return false
    }

    // If this is a URL that starts with /_, skip.
    if (url.pathname.startsWith('/_')) {
      return false
    }

    // If this looks like a URL for a resource, because it contains
    // a file extension, skip.
    if (url.pathname.match(fileExtensionRegexp)) {
      return false
    }

    // Return true to signal that we want to use the handler.
    return true
  },
  createHandlerBoundToURL(`${ process.env.PUBLIC_URL }/index.html`),
)

// Cache resources that aren't being precached
// -----------------------------------------------------------------------------

registerRoute(
  new RegExp('/fonts.css'),
  new StaleWhileRevalidate({
    cacheName: 'fonts',
    plugins: [
      // Ensure that once this runtime cache reaches a maximum size the
      // least-recently used images are removed.
      new ExpirationPlugin({ maxEntries: 50 }),
    ],
  }),
)

// since we serve fonts from, don't forget to append new ?v= param when
// updating fonts (glyphs) without changing the filename
registerRoute(
  new RegExp('/.+.(ttf|woff2|otf)'),
  new CacheFirst({
    cacheName: 'fonts',
    plugins: [
      // Ensure that once this runtime cache reaches a maximum size the
      // least-recently used images are removed.
      new ExpirationPlugin({
        maxEntries: 50,
        // 90 days
        maxAgeSeconds: 7776000000,
      }),
    ],
  }),
)

registerRoute(
  new RegExp('/locales\\/[\\w-]+json'),
  // Customize this strategy as needed, e.g., by changing to CacheFirst.
  new CacheFirst({
    cacheName: 'locales',
    plugins: [
      // Ensure that once this runtime cache reaches a maximum size the
      // least-recently used images are removed.
      new ExpirationPlugin({
        maxEntries: 50,
        // 30 days
        maxAgeSeconds: 2592000000,
      }),
    ],
  }),
)

// -----------------------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  if (
    event.request.method === 'POST' &&
    event.request.url.endsWith('/web-share-target')
  ) {
    return event.respondWith(
      (async () => {
        const formData = await event.request.formData()
        const file = formData.get('file')
        const webShareTargetCache = await caches.open('web-share-target')
        await webShareTargetCache.put('shared-file', new Response(file))
        return Response.redirect('/?web-share-target', 303)
      })(),
    )
  }
})

// This allows the web app to trigger skipWaiting via
// registration.waiting.postMessage({type: 'SKIP_WAITING'})
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})
