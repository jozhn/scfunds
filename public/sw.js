// 数据文件走的 CDN（js.org 的 Cloudflare 区域）不缓存任何内容，GitHub Pages 又只给
// Cache-Control: max-age=600，所以这里用 Service Worker 做浏览器侧的持久缓存：
// 数据文件先返回缓存、后台静默更新；带 hash 的静态资源永久命中缓存。
const CACHE_VERSION = 'v1'
const CACHE_PREFIX = 'scfunds-'
const DATA_CACHE = `${CACHE_PREFIX}data-${CACHE_VERSION}`
const ASSET_CACHE = `${CACHE_PREFIX}assets-${CACHE_VERSION}`
const PAGE_CACHE = `${CACHE_PREFIX}page-${CACHE_VERSION}`

const DATA_FRESH_MS = 60 * 60 * 1000
const MAX_DATA_ENTRIES = 150
const MAX_ASSET_ENTRIES = 30

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && !key.endsWith(CACHE_VERSION))
          .map((key) => caches.delete(key)),
      )
      await self.clients.claim()
    })(),
  )
})

async function trim(cache, maxEntries) {
  const keys = await cache.keys()
  if (keys.length <= maxEntries) return
  await Promise.all(keys.slice(0, keys.length - maxEntries).map((key) => cache.delete(key)))
}

function cachedAtMs(response) {
  const value = Date.parse(response.headers.get('date') || response.headers.get('last-modified') || '')
  return Number.isFinite(value) ? value : 0
}

async function revalidate(request, cache, maxEntries) {
  const response = await fetch(request)
  // 304 说明浏览器 HTTP 缓存里还是最新的，保留原缓存即可。
  if (response.ok) {
    await cache.put(request, response.clone())
    await trim(cache, maxEntries)
  }
}

async function staleWhileRevalidate(event, request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)

  if (!cached) {
    const response = await fetch(request)
    if (response.ok) {
      await cache.put(request, response.clone())
      await trim(cache, maxEntries)
    }
    return response
  }

  if (Date.now() - cachedAtMs(cached) > DATA_FRESH_MS) {
    event.waitUntil(revalidate(request, cache, maxEntries).catch(() => undefined))
  }

  return cached
}

async function cacheFirst(event, request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)
  if (cached) return cached

  const response = await fetch(request)
  if (response.ok) {
    await cache.put(request, response.clone())
    await trim(cache, maxEntries)
  }
  return response
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  try {
    const response = await fetch(request)
    if (response.ok) await cache.put(request, response.clone())
    return response
  } catch (error) {
    const cached = (await cache.match(request)) || (await cache.match(self.registration.scope))
    if (cached) return cached
    throw error
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, PAGE_CACHE))
    return
  }

  if (url.pathname.includes('/data/')) {
    event.respondWith(staleWhileRevalidate(event, request, DATA_CACHE, MAX_DATA_ENTRIES))
    return
  }

  if (url.pathname.includes('/assets/')) {
    event.respondWith(cacheFirst(event, request, ASSET_CACHE, MAX_ASSET_ENTRIES))
  }
})
