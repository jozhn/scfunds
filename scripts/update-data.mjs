import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { classifyType, computeFundMetrics, FEE_RATE, PERIODS } from '../src/lib/finance.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const SC_AUTH = `Basic ${Buffer.from('webpreview:W@bpurv!ew2970').toString('base64')}`
const SC_LIST_URL = 'https://av.sc.com/tds/cn-sc/data/investment-funds-list/fund_listing.json'
const SC_ONSHORE_FUND_URL = 'https://www.sc.com/cn/investment/on-shore-fund-selection/'
const SC_GRAPHQL_URL = 'https://www.sc.com/cn/graphql/'
const DANJUAN_FUND_URL = 'https://danjuanfunds.com/funding'
const DANJUAN_API_URL = 'https://danjuanfunds.com/djapi'
const TIANTIAN_MAIN_URL = 'https://j5.fund.eastmoney.com/sc/tfs/qt/v2.0.1'
const TIANTIAN_H5_FUND_URL = 'https://h5.1234567.com.cn/app/fund-details/'
const EASTMONEY_FUND_CODE_URL = 'https://fund.eastmoney.com/js/fundcode_search.js'
const SC_FEE_DISCOUNT_FACTOR = 0.1

const MANAGER_ALIASES = [
  '华泰柏瑞',
  '前海开源',
  '国泰海通',
  '易方达',
  '汇添富',
  '景顺长城',
  '东方红',
  '国联安',
  '工银瑞信',
  '华安',
  '华夏',
  '摩根',
  '博时',
  '富国',
  '南方',
  '广发',
  '天弘',
  '嘉实',
  '平安',
  '银华',
  '大成',
  '工银',
  '国泰',
  '华宝',
  '鹏华',
  '招商',
  '兴业',
  '中银',
  '建信',
  '国富',
  '融通',
  '中欧',
  '永赢',
  '东财',
  '长城',
  '交银',
  '国投瑞银',
  '农银汇理',
]

const TARGET_ETF_CODE_OVERRIDES = {
  '017469': '588200',
  '017470': '588200',
  '021870': '588200',
}

const CURRENCY_CODES = {
  人民币: 'CNY',
  美元: 'USD',
  欧元: 'EUR',
  港元: 'HKD',
  英镑: 'GBP',
  澳大利亚元: 'AUD',
  新加坡元: 'SGD',
}

const DATA_START = shiftYear(new Date(), -5).toISOString().slice(0, 10)
const DATA_END = new Date().toISOString().slice(0, 10)

function shiftYear(date, years) {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  copy.setUTCFullYear(copy.getUTCFullYear() + years)
  return copy
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

async function fetchJson(url, options = {}, retries = 2) {
  let lastError

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, options)
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      return response.json()
    } catch (error) {
      lastError = error
      if (attempt < retries) await sleep(500 * (attempt + 1))
    }
  }

  throw lastError
}

async function fetchText(url, options = {}, retries = 2) {
  let lastError

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, options)
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      return response.text()
    } catch (error) {
      lastError = error
      if (attempt < retries) await sleep(500 * (attempt + 1))
    }
  }

  throw lastError
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let index = 0

  async function next() {
    while (index < items.length) {
      const current = index
      index += 1
      results[current] = await worker(items[current], current)
    }
  }

  await Promise.all(Array.from({ length: limit }, next))
  return results
}

function fundCodeFromCmf(fund) {
  const nameMatch = String(fund.name || '').match(/^\s*(\d{6})/)
  if (nameMatch) return nameMatch[1]

  const digits = String(fund.isin || '').replace(/\D/g, '')
  if (!digits) return null
  return digits.slice(-6).padStart(6, '0')
}

function normalizeHistory(history) {
  return history
    .filter((point) => point.date >= DATA_START && Number.isFinite(point.value) && point.value > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
}

function packHistory(history) {
  return normalizeHistory(history).map((point) => {
    const packed = [point.date, Number(point.value.toFixed(6))]
    if (Number.isFinite(point.dailyReturn)) packed.push(Number(point.dailyReturn.toFixed(8)))
    return packed
  })
}

function packGrowthSeries(history) {
  return history.map((point) => [
    point.date,
    Number(point.value.toFixed(8)),
    Number.isFinite(point.benchmarkValue) ? Number(point.benchmarkValue.toFixed(8)) : null,
    Number.isFinite(point.performanceValue) ? Number(point.performanceValue.toFixed(8)) : null,
  ])
}

function returnHistoryFromGrowth(growthSeries) {
  return normalizeHistory(
    growthSeries.map((point) => ({
      date: point.date,
      value: 1 + Number(point.value),
    })),
  )
}

function alignIntervalReturnsWithXueqiu(metrics, xueqiuReturns) {
  if (!metrics?.intervals || !xueqiuReturns) return metrics

  const intervals = { ...metrics.intervals }
  for (const period of PERIODS) {
    const xueqiuReturn = Number(xueqiuReturns[period.key])
    const interval = intervals[period.key]
    if (!interval || !Number.isFinite(xueqiuReturn) || xueqiuReturn <= -1) continue

    intervals[period.key] = {
      ...interval,
      totalReturn: xueqiuReturn,
      annualizedReturn: interval.days ? (1 + xueqiuReturn) ** (365 / interval.days) - 1 : interval.annualizedReturn,
    }
  }

  return {
    ...metrics,
    intervals,
  }
}

async function fetchStandardCharteredChart(fund) {
  const query = `query MyQuery { morningStarChart(isin: "${fund.isin}", range: "all", currency:"${fund.currency}") }`
  const payload = await fetchJson(SC_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: SC_AUTH,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query }),
  })

  const chart = payload?.data?.morningStarChart
  if (!chart) return []

  const parsed = JSON.parse(chart)
  return normalizeHistory(
    (parsed?.api?.r || []).map((point) => ({
      date: point.d,
      value: Number(point.v),
    })),
  )
}

async function fetchStandardCharteredProfile(fund) {
  const query = `query MyQuery { morningStar(isin:"${fund.isin}",currency:"${fund.currency}") }`
  const payload = await fetchJson(SC_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: SC_AUTH,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query }),
  })

  const detail = payload?.data?.morningStar
  if (!detail) return emptyHoldingProfile()

  return extractHoldingProfile(JSON.parse(detail))
}

function emptyHoldingProfile() {
  return {
    asset: [],
    geography: [],
    sector: [],
    topHoldings: [],
    fundHoldings: [],
    lastUpdated: '',
  }
}

function toWeight(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function normalizeAllocationObject(object = {}) {
  return Object.entries(object)
    .map(([label, value]) => ({ label, weight: toWeight(value) }))
    .filter((item) => item.label && Number.isFinite(item.weight) && item.weight > 0)
    .sort((a, b) => b.weight - a.weight)
}

function normalizeAllocationArray(array = [], labelKey, valueKey) {
  return array
    .map((item) => ({ label: item?.[labelKey], weight: toWeight(item?.[valueKey]) }))
    .filter((item) => item.label && Number.isFinite(item.weight) && item.weight > 0)
    .sort((a, b) => b.weight - a.weight)
}

function extractHoldingProfile(detail = {}) {
  const tabs = detail?.allocation?.tabs || {}

  return {
    asset: normalizeAllocationObject(tabs.asset),
    geography: normalizeAllocationArray(tabs.geography, 'Country', 'Value'),
    sector: normalizeAllocationObject(tabs.sector),
    topHoldings: (detail.top_holdings || [])
      .map((holding) => ({
        name: holding?.Name || '',
        country: holding?.Country || '',
        sector: holding?.Sector || holding?.GlobalSector || '',
        weight: toWeight(holding?.Weighting),
      }))
      .filter((holding) => holding.name && Number.isFinite(holding.weight))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 10),
    lastUpdated: detail.last_updated || '',
  }
}

const danjuanFundInfoCache = new Map()
const targetEtfHoldingCache = new Map()
const tiantianMainCache = new Map()

function decodeHtml(value = '') {
  return String(value)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
}

function textFromHtml(html = '') {
  return decodeHtml(html)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function danjuanFundUrl(code) {
  return `${DANJUAN_FUND_URL}/${code}`
}

function tiantianFundDetailUrl(code) {
  return `${TIANTIAN_H5_FUND_URL}?fCode=${code}`
}

function buildFundLinks(fund, fundCode) {
  const links = {
    standardChartered: SC_ONSHORE_FUND_URL,
  }

  if (fund['fund-type'] === 'cmf' && fundCode) {
    links.danjuan = danjuanFundUrl(fundCode)
    links.tiantian = tiantianFundDetailUrl(fundCode)
  }

  return links
}

function extractTableRows(html = '') {
  const tbody = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)?.[1] || html
  return [...tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[1])
}

function extractTableCells(row = '') {
  return [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => match[1])
}

function extractLinks(html = '') {
  return [...html.matchAll(/<a\b[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi)].map((match) => ({
    href: new URL(decodeHtml(match[1]), SC_ONSHORE_FUND_URL).href,
    text: textFromHtml(match[2]),
  }))
}

function chinaYearMonth(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: 'numeric',
    })
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  )
  const month = String(parts.month).padStart(2, '0')

  return {
    label: `${parts.year}年${Number(parts.month)}月`,
    compact: `${parts.year}${month}`,
  }
}

function previousChinaYearMonth(date = new Date()) {
  const previous = new Date(date)
  previous.setMonth(previous.getMonth() - 1)
  return chinaYearMonth(previous)
}

function currentFeeDiscountMonths(date = new Date()) {
  return new Set([chinaYearMonth(date).compact, previousChinaYearMonth(date).compact])
}

function noticeMonth(notice) {
  const textMatch = notice.text.match(/(20\d{2})年\s*(\d{1,2})月/)
  if (textMatch) return `${textMatch[1]}${textMatch[2].padStart(2, '0')}`

  const urlMatch = notice.href.match(/(20\d{2})(\d{2})[^/]*fee-discount/i)
  return urlMatch ? `${urlMatch[1]}${urlMatch[2]}` : ''
}

async function fetchStandardCharteredOnshoreDisclosure() {
  const html = await fetchText(SC_ONSHORE_FUND_URL)
  const currentMonth = chinaYearMonth()
  const activeDiscountMonths = currentFeeDiscountMonths()
  const byCode = {}
  const feeDiscountNotices = []

  for (const row of extractTableRows(html)) {
    const cells = extractTableCells(row)
    const code = textFromHtml(cells[0] || '').match(/\d{6}/)?.[0]
    if (!code) continue

    const links = extractLinks(row)
    const discountNotices = links
      .filter((link) => /fee-discount-announcement\.pdf/i.test(link.href))
      .map((link) => ({
        ...link,
        month: noticeMonth(link),
      }))
    const currentDiscount = discountNotices.find((notice) => activeDiscountMonths.has(notice.month)) || null

    if (discountNotices.length) {
      feeDiscountNotices.push(
        ...discountNotices.map((notice) => ({
          code,
          title: notice.text,
          url: notice.href,
          month: notice.month,
          currentMonth: activeDiscountMonths.has(notice.month),
        })),
      )
    }

    byCode[code] = {
      code,
      name: textFromHtml(cells[1] || ''),
      manager: textFromHtml(cells[2] || ''),
      notices: discountNotices,
      currentFeeDiscount: currentDiscount
        ? {
            title: currentDiscount.text,
            url: currentDiscount.href,
            month: currentDiscount.month,
            discountFactor: SC_FEE_DISCOUNT_FACTOR,
          }
        : null,
    }
  }

  return {
    url: SC_ONSHORE_FUND_URL,
    currentMonth,
    activeDiscountMonths: [...activeDiscountMonths],
    byCode,
    feeDiscountNotices,
  }
}

async function fetchEastmoneyFundDirectory() {
  const script = await fetchText(EASTMONEY_FUND_CODE_URL, {
    headers: {
      Referer: 'https://fund.eastmoney.com/',
      'User-Agent': 'Mozilla/5.0',
    },
  })
  const start = script.indexOf('[')
  const end = script.lastIndexOf(']') + 1
  if (start < 0 || end <= start) return []

  return JSON.parse(script.slice(start, end)).map(([code, pinyin, name, type, spell]) => ({
    code,
    pinyin,
    name,
    type,
    spell,
  }))
}

function managerAlias(...values) {
  const text = values.filter(Boolean).join('')
  return MANAGER_ALIASES.find((alias) => text.includes(alias)) || ''
}

function stripFundCode(name = '') {
  return String(name).replace(/^\s*\d{6}\s*[-－—]?\s*/, '').trim()
}

function normalizeFundName(value = '') {
  return stripFundCode(value)
    .replace(/交易型开放式指数证券投资基金/g, 'ETF')
    .replace(/交易型开放式指数基金/g, 'ETF')
    .replace(/交易型开放式基金/g, 'ETF')
    .replace(/开放式指数证券投资基金/g, 'ETF')
    .replace(/证券投资基金/g, '')
    .replace(/上证/g, '')
    .replace(/科创板/g, '科创')
    .replace(/中证/g, '')
    .replace(/指数/g, '')
    .replace(/主题/g, '')
    .replace(/发起式/g, '')
    .replace(/发起/g, '')
    .replace(/联接基金/g, '')
    .replace(/联接/g, '')
    .replace(/连接/g, '')
    .replace(/基金/g, '')
    .replace(/LOF/g, '')
    .replace(/[A-Z]?类份额$/i, '')
    .replace(/[A-Z]$/i, '')
    .replace(/[\s()（）【】·•,，:：_\\－—/-]/g, '')
    .trim()
}

function bigrams(value) {
  const chars = [...value]
  if (chars.length <= 1) return chars

  return chars.slice(0, -1).map((_, index) => chars.slice(index, index + 2).join(''))
}

function diceSimilarity(a, b) {
  const aGrams = bigrams(a)
  const bGrams = bigrams(b)
  if (!aGrams.length || !bGrams.length) return 0

  const counts = new Map()
  for (const gram of aGrams) counts.set(gram, (counts.get(gram) || 0) + 1)

  let overlap = 0
  for (const gram of bGrams) {
    const count = counts.get(gram) || 0
    if (count) {
      overlap += 1
      counts.set(gram, count - 1)
    }
  }

  return (2 * overlap) / (aGrams.length + bGrams.length)
}

function charOverlap(a, b) {
  const aChars = new Set([...a])
  const bChars = new Set([...b])
  if (!aChars.size || !bChars.size) return 0

  let overlap = 0
  for (const char of aChars) {
    if (bChars.has(char)) overlap += 1
  }

  return overlap / Math.min(aChars.size, bChars.size)
}

function isEtfLinkFund(fund, fundInfo) {
  const text = `${fund?.name || ''}${fundInfo?.fd_name || ''}${fundInfo?.fd_full_name || ''}`
  return /(ETF|交易型开放式)/i.test(text) && /(联接|连接)/.test(text)
}

function findTargetEtfByName(fund, fundInfo, fundDirectory = []) {
  const fundCode = fundCodeFromCmf(fund)
  const overrideCode = TARGET_ETF_CODE_OVERRIDES[fundCode]
  if (overrideCode) {
    const override = fundDirectory.find((item) => item.code === overrideCode)
    return {
      code: overrideCode,
      name: override?.name || overrideCode,
      source: 'manual-target-map',
      score: 999,
    }
  }

  if (!isEtfLinkFund(fund, fundInfo)) return null

  const sourceName = fundInfo?.fd_full_name || fundInfo?.fd_name || fund?.name || ''
  const sourceCore = normalizeFundName(sourceName)
  const sourceManager = managerAlias(sourceName, fund?.house, fundInfo?.keeper_name)
  let best = null

  for (const item of fundDirectory) {
    if (!item?.name?.includes('ETF') || /联接|连接/.test(item.name)) continue

    const candidateCore = normalizeFundName(item.name)
    const candidateManager = managerAlias(item.name)
    let score = diceSimilarity(sourceCore, candidateCore) * 80 + charOverlap(sourceCore, candidateCore) * 80

    if (sourceManager && candidateManager === sourceManager) score += 45
    if (sourceCore.includes(candidateCore) || candidateCore.includes(sourceCore)) score += 45
    if (/^(5|1)/.test(item.code)) score += 4

    if (!best || score > best.score) {
      best = {
        code: item.code,
        name: item.name,
        type: item.type,
        source: 'eastmoney-name-match',
        score,
        sourceCore,
        candidateCore,
      }
    }
  }

  return best?.score >= 95 ? best : null
}

function xueqiuHeaders(fundCode) {
  return {
    Accept: 'application/json,text/plain,*/*',
    Referer: fundCode ? danjuanFundUrl(fundCode) : DANJUAN_FUND_URL,
    'User-Agent': 'Mozilla/5.0',
  }
}

async function fetchDanjuanJson(path, fundCode, retries = 2) {
  const url = path.startsWith('http') ? path : `${DANJUAN_API_URL}${path}`
  const payload = await fetchJson(url, { headers: xueqiuHeaders(fundCode) }, retries)
  if (payload?.result_code && payload.result_code !== 0) {
    throw new Error(payload.message || `雪球接口错误 ${payload.result_code}`)
  }
  return payload?.data ?? payload
}

async function fetchDanjuanFundInfo(fundCode) {
  if (!fundCode) return null
  if (!danjuanFundInfoCache.has(fundCode)) {
    danjuanFundInfoCache.set(fundCode, fetchDanjuanJson(`/fund/${fundCode}`, fundCode).catch(() => null))
  }
  return danjuanFundInfoCache.get(fundCode)
}

function parseDanjuanRate(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number / 100 : null
}

function parseDanjuanDiscountFactor(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function parseDanjuanPurchaseFee(fundInfo) {
  const rates = fundInfo?.fund_rates || {}
  const officialRate = parseDanjuanRate(rates.declare_rate ?? rates.subscribe_rate)
  const platformDiscountFactor = parseDanjuanDiscountFactor(rates.declare_discount ?? rates.discount)
  const platformRate =
    Number.isFinite(officialRate) && Number.isFinite(platformDiscountFactor)
      ? officialRate * platformDiscountFactor
      : null

  return {
    officialRate,
    platformRate,
    platformDiscountFactor,
  }
}

function inferCountryFromXueqiuSymbol(symbol = '', code = '') {
  const symbolValue = String(symbol || '').trim().toUpperCase()
  const codeValue = String(code || '').trim().toUpperCase()
  const value = symbolValue || codeValue
  if (/^(SH|SZ|BJ)\d{6}$/.test(symbolValue)) return '中国内地'
  if (/^HK/.test(value) || /^0\d{4}$/.test(value) || /^8\d{4}$/.test(value)) return '中国香港'
  if (/^JP/.test(value)) return '日本'
  if (/^(GB|UK)/.test(value)) return '英国'
  if (/^KR/.test(value)) return '韩国'
  if (/^[A-Z.]{1,8}$/.test(value)) return '美国'
  return inferRegionFromSecid(code)
}

function xueqiuHoldingFromStock(item) {
  const dailyReturn = Number(item?.change_percentage)
  return {
    name: item?.name || '',
    code: item?.code || '',
    xqSymbol: item?.xq_symbol || '',
    sourceUrl: item?.xq_url || '',
    country: inferCountryFromXueqiuSymbol(item?.xq_symbol, item?.code),
    sector: item?.industry_label || '',
    weight: Number(item?.percent_double ?? item?.percent),
    dailyReturn: Number.isFinite(dailyReturn) ? dailyReturn / 100 : null,
    lastPrice: Number.isFinite(Number(item?.current_price)) ? Number(item.current_price) : null,
    quarterChange: item?.change_of_pre_quarter || '',
    quarterChangeType: item?.change_of_pre_quarter_type ?? null,
  }
}

function parseTiantianPercent(value) {
  const number = Number(String(value ?? '').replace(/,/g, '').replace('%', '').trim())
  return Number.isFinite(number) ? number : null
}

function tiantianAllocationDate(payload) {
  const allocation = payload?.JJCC?.Datas?.AssetAllocation || {}
  const expansion = payload?.JJCC?.Expansion
  if (expansion && allocation[expansion]) return expansion

  return Object.keys(allocation)
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort()
    .at(-1) || expansion || ''
}

function parseTiantianAssetAllocation(payload) {
  const allocation = payload?.JJCC?.Datas?.AssetAllocation || {}
  const date = tiantianAllocationDate(payload)
  const row = (date && allocation[date]?.[0]) || Object.values(allocation).flat().at(-1) || null
  if (!row) return { date, items: [] }

  const items = [
    ['GP', '股票'],
    ['ZQ', '债券'],
    ['HB', '现金'],
    ['JJ', '基金'],
    ['QT', '其他'],
  ]
    .map(([key, label]) => ({ label, weight: parseTiantianPercent(row[key]) }))
    .filter((item) => Number.isFinite(item.weight) && item.weight > 0)
    .sort((a, b) => b.weight - a.weight)

  return { date: row.FSRQ || date, items }
}

function cleanTiantianLabel(value = '') {
  const label = String(value || '').trim()
  return label && label !== '--' ? label : ''
}

function tiantianStockExchangePrefix(item = {}) {
  const code = String(item.GPDM || '').trim()
  const exchange = String(item.NEWTEXCH || item.TEXCH || '')
  if (!/^\d{6}$/.test(code)) return ''
  if (exchange === '1' || /^(5|6|9)/.test(code)) return 'SH'
  if (exchange === '0' || exchange === '2' || /^(0|1|2|3)/.test(code)) return 'SZ'
  return ''
}

function tiantianSecuritySymbol(item = {}) {
  const code = String(item.GPDM || '').trim()
  if (!code) return ''

  const prefix = tiantianStockExchangePrefix(item)
  if (prefix) return `${prefix}${code}`
  if (/^[A-Z.]{1,8}$/.test(code)) return code.toUpperCase()
  if (/^HK/i.test(code)) return code.toUpperCase()
  if (/^0\d{4}$/.test(code) || /^8\d{4}$/.test(code)) return `HK${code}`
  return ''
}

function inferCountryFromTiantianStock(item = {}) {
  const code = String(item.GPDM || '').trim().toUpperCase()
  const exchange = String(item.NEWTEXCH || item.TEXCH || '').trim()

  if (['0', '1', '2', '80', '81', '82', '83', '90'].includes(exchange)) return '中国内地'
  if (['116', '128'].includes(exchange)) return '中国香港'
  if (['105', '106', '107'].includes(exchange)) return '美国'
  if (['155', '156'].includes(exchange)) return '英国'
  if (/^JP/.test(code)) return '日本'
  if (/^KR/.test(code)) return '韩国'
  if (/^[A-Z.]{1,8}$/.test(code)) return '美国'

  return inferCountryFromXueqiuSymbol(tiantianSecuritySymbol(item), code)
}

function tiantianHoldingFromStock(item) {
  const code = String(item?.GPDM || '').trim()
  const symbol = tiantianSecuritySymbol(item)

  return {
    name: item?.GPJC || '',
    code,
    xqSymbol: symbol,
    sourceUrl: symbol ? `https://xueqiu.com/S/${symbol}` : '',
    country: inferCountryFromTiantianStock(item),
    sector: cleanTiantianLabel(item?.INDEXNAME),
    weight: parseTiantianPercent(item?.JZBL),
    dailyReturn: null,
    lastPrice: null,
    quarterChange: item?.PCTNVCHGTYPE || '',
    quarterChangeType: null,
  }
}

function parseTiantianFundHoldings(payload, fundCode) {
  const position = payload?.JJCC?.Datas?.InverstPosition || {}
  const assetAllocation = parseTiantianAssetAllocation(payload)
  const fundWeight = assetAllocation.items.find((item) => item.label === '基金')?.weight ?? null
  const date = tiantianAllocationDate(payload)
  const holdings = []

  if (position.ETFCODE) {
    holdings.push({
      code: position.ETFCODE,
      name: position.ETFSHORTNAME || position.ETFCODE,
      weight: fundWeight,
      source: 'tiantian',
      sourceUrl: tiantianFundDetailUrl(fundCode),
      targetSourceUrl: danjuanFundUrl(position.ETFCODE),
      lastUpdated: date,
      estimatedWeight: !Number.isFinite(fundWeight),
    })
  }

  const fundfofs = Array.isArray(position.fundfofs) ? position.fundfofs : []
  for (const item of fundfofs) {
    const code = String(item.FCODE || item.JJDM || item.FUND_CODE || item.FUNDCODE || '').match(/\d{6}/)?.[0] || ''
    const name = item.SHORTNAME || item.JJJC || item.FUND_NAME || item.FUNDNAME || code
    if (!code && !name) continue

    holdings.push({
      code,
      name,
      weight: parseTiantianPercent(item.JZBL ?? item.ZJZBL ?? item.PCTNV ?? item.HOLDPROPORTION),
      source: 'tiantian',
      sourceUrl: tiantianFundDetailUrl(fundCode),
      targetSourceUrl: code ? danjuanFundUrl(code) : '',
      lastUpdated: item.FSRQ || item.REPORTDATE || date,
      estimatedWeight: false,
    })
  }

  return holdings.sort((a, b) => (b.weight ?? -1) - (a.weight ?? -1))
}

function parseTiantianAssetProfile(payload, fundCode) {
  const position = payload?.JJCC?.Datas?.InverstPosition || {}
  const assetAllocation = parseTiantianAssetAllocation(payload)
  const topHoldings = (position.fundStocks || [])
    .map(tiantianHoldingFromStock)
    .filter((holding) => holding.name && Number.isFinite(holding.weight) && holding.weight > 0)
    .slice(0, 10)

  return {
    asset: assetAllocation.items,
    geography: allocationFromHoldings(topHoldings, 'country'),
    sector: allocationFromHoldings(topHoldings, 'sector'),
    topHoldings,
    directTopHoldings: [],
    topHoldingsLookThrough: false,
    fundHoldings: parseTiantianFundHoldings(payload, fundCode),
    lastUpdated: assetAllocation.date,
    source: 'tiantian',
  }
}

async function fetchTiantianFundMain(fundCode) {
  const key = String(fundCode || '').trim()
  if (!key) return null
  if (tiantianMainCache.has(key)) return tiantianMainCache.get(key)

  const task = (async () => {
    const url = `${TIANTIAN_MAIN_URL}/${key}.json?curTime=${Date.now()}`
    const payload = await fetchJson(
      url,
      {
        headers: {
          Referer: 'https://h5.1234567.com.cn/',
          'User-Agent': 'Mozilla/5.0',
        },
      },
      2,
    ).catch(() => null)

    return payload
  })()

  tiantianMainCache.set(key, task)
  return task
}

async function fetchTiantianAssetProfile(fundCode) {
  const payload = await fetchTiantianFundMain(fundCode)
  return payload ? parseTiantianAssetProfile(payload, fundCode) : emptyHoldingProfile()
}

function profileDateScore(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return 0
  return Math.floor((new Date(`${date}T00:00:00Z`).getTime() - new Date('2000-01-01T00:00:00Z').getTime()) / 30 / 24 / 60 / 60 / 1000)
}

function holdingProfileScore(profile) {
  if (!profile) return -Infinity
  const topHoldings = profile.topHoldings || []

  return (
    topHoldings.length * 10 +
    (profile.fundHoldings?.length || 0) * 25 +
    (profile.asset?.length || 0) * 2 +
    topHoldings.filter((holding) => holding.country).length * 0.5 +
    topHoldings.filter((holding) => holding.sector).length * 3 +
    topHoldings.filter((holding) => Number.isFinite(holding.dailyReturn)).length +
    profileDateScore(profile.lastUpdated)
  )
}

function mergeHoldingDetails(primaryHoldings = [], referenceHoldings = []) {
  const byCode = new Map()
  for (const holding of referenceHoldings) {
    const key = holding.code || holding.xqSymbol || holding.name
    if (key) byCode.set(key, holding)
  }

  return primaryHoldings.map((holding) => {
    const reference = byCode.get(holding.code) || byCode.get(holding.xqSymbol) || byCode.get(holding.name)
    if (!reference) return holding

    return {
      ...holding,
      xqSymbol: holding.xqSymbol || reference.xqSymbol || '',
      sourceUrl: holding.sourceUrl || reference.sourceUrl || '',
      country: holding.country || reference.country || '',
      sector: holding.sector || reference.sector || '',
      dailyReturn: Number.isFinite(holding.dailyReturn) ? holding.dailyReturn : reference.dailyReturn ?? null,
      lastPrice: Number.isFinite(holding.lastPrice) ? holding.lastPrice : reference.lastPrice ?? null,
    }
  })
}

function bestHoldingProfile(...profiles) {
  const candidates = profiles.filter(Boolean)
  if (!candidates.length) return emptyHoldingProfile()

  const best = candidates.sort((a, b) => holdingProfileScore(b) - holdingProfileScore(a))[0]
  const references = candidates.filter((profile) => profile !== best).flatMap((profile) => profile.topHoldings || [])
  return {
    ...best,
    topHoldings: mergeHoldingDetails(best.topHoldings || [], references),
  }
}

function parseDanjuanAssetProfile(data = {}) {
  const topHoldings = (data?.stock_list || [])
    .map(xueqiuHoldingFromStock)
    .filter((holding) => holding.name && Number.isFinite(holding.weight) && holding.weight > 0)
    .slice(0, 10)
  const asset = (data?.chart_list || [])
    .map((item) => ({
      label: item.type_desc || '',
      weight: Number(item.percent),
      color: item.color || '',
    }))
    .filter((item) => item.label && Number.isFinite(item.weight) && item.weight > 0)
    .sort((a, b) => b.weight - a.weight)

  return {
    asset,
    geography: allocationFromHoldings(topHoldings, 'country'),
    sector: allocationFromHoldings(topHoldings, 'sector'),
    topHoldings,
    directTopHoldings: [],
    topHoldingsLookThrough: false,
    fundHoldings: [],
    lastUpdated: data?.source_mark || data?.source || '',
    source: 'xueqiu',
  }
}

async function fetchDanjuanAssetProfile(fundCode) {
  const data = await fetchDanjuanJson(`/fundx/base/fund/record/asset/percent?fund_code=${fundCode}`, fundCode)
  return parseDanjuanAssetProfile(data)
}

async function fetchBestAssetProfile(fundCode) {
  const [xueqiuResult, tiantianResult] = await Promise.allSettled([
    fetchDanjuanAssetProfile(fundCode),
    fetchTiantianAssetProfile(fundCode),
  ])
  const xueqiuProfile = xueqiuResult.status === 'fulfilled' ? xueqiuResult.value : null
  const tiantianProfile = tiantianResult.status === 'fulfilled' ? tiantianResult.value : null

  return bestHoldingProfile(tiantianProfile, xueqiuProfile)
}

function targetFundWeight(profile) {
  const fundAsset =
    profile.asset.find((item) => /基金|ETF/.test(item.label) && Number.isFinite(item.weight)) ||
    profile.asset.find((item) => /其他/.test(item.label) && Number.isFinite(item.weight))
  return fundAsset?.weight ?? null
}

function mergeStockHoldings(holdings) {
  const byKey = new Map()

  for (const holding of holdings) {
    if (!holding?.name || !Number.isFinite(holding.weight)) continue

    const key = holding.code || holding.xqSymbol || holding.name
    const current = byKey.get(key)
    if (!current) {
      byKey.set(key, { ...holding })
      continue
    }

    byKey.set(key, {
      ...current,
      country: current.country || holding.country || '',
      sector: current.sector || holding.sector || '',
      weight: Number((current.weight + holding.weight).toFixed(6)),
    })
  }

  return [...byKey.values()].sort((a, b) => b.weight - a.weight)
}

function mergeAssetAllocations(items) {
  const totals = items.reduce((accumulator, item) => {
    if (!item?.label || !Number.isFinite(item.weight) || item.weight <= 0) return accumulator
    accumulator[item.label] = (accumulator[item.label] || 0) + item.weight
    return accumulator
  }, {})

  return Object.entries(totals)
    .map(([label, weight]) => ({ label, weight: Number(weight.toFixed(6)) }))
    .sort((a, b) => b.weight - a.weight)
}

function scaledAllocations(items, weight) {
  if (!Number.isFinite(weight)) return []

  return items
    .filter((item) => item.label !== '其他' && Number.isFinite(item.weight))
    .map((item) => ({
      ...item,
      weight: Number((item.weight * weight / 100).toFixed(6)),
    }))
}

async function fetchTargetEtfHoldingProfile(target) {
  const code = target?.code
  if (!code) return null
  if (targetEtfHoldingCache.has(code)) return targetEtfHoldingCache.get(code)

  const task = fetchBestAssetProfile(code)
    .then((profile) => ({
      ...profile,
      sourceUrl: danjuanFundUrl(code),
    }))
    .catch(() => null)

  targetEtfHoldingCache.set(code, task)
  return task
}

async function fetchDanjuanHoldingProfile(fund, fundCode, fundInfo, fundDirectory = []) {
  const profile = await fetchBestAssetProfile(fundCode)
  const target = profile.fundHoldings?.[0] || findTargetEtfByName(fund, fundInfo, fundDirectory)
  if (!target) return profile

  const targetProfile = await fetchTargetEtfHoldingProfile(target)
  const targetWeight = Number.isFinite(target.weight) ? target.weight : targetFundWeight(profile)
  if (!targetProfile?.topHoldings?.length || !Number.isFinite(targetWeight)) return profile

  const lookThroughHoldings = targetProfile.topHoldings.map((holding) => ({
    ...holding,
    weight: Number((targetWeight * holding.weight / 100).toFixed(6)),
    sourceFundCode: target.code,
    sourceFundName: target.name,
  }))
  const topHoldings = mergeStockHoldings([...lookThroughHoldings, ...profile.topHoldings]).slice(0, 10)
  const fundHoldings = [
    {
      code: target.code,
      name: target.name,
      weight: targetWeight,
      source: target.source,
      sourceUrl: target.sourceUrl || '',
      targetSourceUrl: targetProfile.sourceUrl || danjuanFundUrl(target.code),
      lastUpdated: profile.lastUpdated,
      targetLastUpdated: targetProfile.lastUpdated,
      targetHoldings: targetProfile.topHoldings,
      targetGeography: targetProfile.geography,
      targetSector: targetProfile.sector,
      estimatedWeight: false,
    },
  ]
  const directAsset = profile.asset.filter((item) => !/基金|ETF|其他/i.test(item.label))

  return {
    ...profile,
    asset: mergeAssetAllocations([...directAsset, ...scaledAllocations(targetProfile.asset, targetWeight)]),
    geography: allocationFromHoldings(topHoldings, 'country'),
    sector: allocationFromHoldings(topHoldings, 'sector'),
    topHoldings,
    directTopHoldings: profile.topHoldings,
    topHoldingsLookThrough: true,
    fundHoldings,
    lastUpdated: [profile.lastUpdated, targetProfile.lastUpdated].filter(Boolean).sort().at(-1) || profile.lastUpdated,
    source: 'xueqiu-look-through',
  }
}

async function fetchDanjuanHistory(fundCode) {
  const first = await fetchDanjuanJson(`/fund/nav/history/${fundCode}?page=1&size=500`, fundCode)
  const totalPages = first?.total_pages || 1
  const items = [...(first?.items || [])]
  const pages = Array.from({ length: Math.max(0, totalPages - 1) }, (_, index) => index + 2)

  const pageItems = await mapLimit(pages, 3, async (page) => {
    const data = await fetchDanjuanJson(`/fund/nav/history/${fundCode}?page=${page}&size=500`, fundCode)
    await sleep(80)
    return data?.items || []
  })

  items.push(...pageItems.flat())

  return normalizeHistory(
    items.map((point) => ({
      date: point.date,
      value: Number(point.value || point.nav),
      dailyReturn: parseDanjuanRate(point.percentage),
    })),
  )
}

async function fetchDanjuanGrowth(fundCode) {
  const data = await fetchDanjuanJson(`/fund/growth/${fundCode}?day=all`, fundCode)
  return (data?.fund_nav_growth || [])
    .map((point) => ({
      date: point.date,
      value: Number(point.value),
      benchmarkValue: Number(point.than_value),
      performanceValue: Number(point.performance_value),
    }))
    .filter((point) => point.date && Number.isFinite(point.value))
    .sort((a, b) => a.date.localeCompare(b.date))
}

function xueqiuPeriodReturns(fundInfo) {
  const byKey = {}
  for (const item of fundInfo?.nav_tab_list || []) {
    const value = Number(item.nav_growth)
    if (item.nav_tab_value && Number.isFinite(value)) byKey[item.nav_tab_value] = value / 100
  }
  return byKey
}

function inferRegionFromSecid(secid = '') {
  const key = String(secid).trim().toUpperCase()
  const market = key.split('.')[0]

  if (/^JP/.test(key)) return '日本'
  if (/^GB/.test(key)) return '英国'
  if (/^US/.test(key)) return '美国'
  if (/^KR/.test(key)) return '韩国'

  if (['0', '1', '2', '80', '81', '82', '83', '90'].includes(market)) return '中国内地'
  if (['116', '128'].includes(market)) return '中国香港'
  if (['105', '106', '107'].includes(market)) return '美国'
  if (['155', '156'].includes(market)) return '英国'
  if (/^\d{6}$/.test(key)) return '中国内地'

  return ''
}

function buildPurchaseFee(fund, rawFee, onshoreFund) {
  const isCmf = fund['fund-type'] === 'cmf'
  const officialRate = isCmf ? rawFee?.officialRate ?? null : FEE_RATE
  const currentDiscount = isCmf ? onshoreFund?.currentFeeDiscount : null
  const discountFactor = currentDiscount?.discountFactor ?? null
  const effectiveRate = Number.isFinite(officialRate) ? officialRate * (discountFactor ?? 1) : null

  return {
    officialRate,
    effectiveRate,
    platformRate: rawFee?.platformRate ?? null,
    platformDiscountFactor: rawFee?.platformDiscountFactor ?? null,
    minPurchaseAmount: rawFee?.minPurchaseAmount ?? null,
    hasCurrentDiscount: Boolean(currentDiscount),
    discountFactor,
    discountTitle: currentDiscount?.title || '',
    discountUrl: currentDiscount?.url || '',
    discountMonth: currentDiscount?.month || '',
    source: isCmf ? 'xueqiu-official-fund-rate' : 'qdmf-default-assumption',
  }
}

function allocationFromHoldings(holdings, key) {
  const totals = holdings.reduce((accumulator, holding) => {
    const label = holding[key]
    if (!label || !Number.isFinite(holding.weight)) return accumulator
    accumulator[label] = (accumulator[label] || 0) + holding.weight
    return accumulator
  }, {})

  return Object.entries(totals)
    .map(([label, weight]) => ({ label, weight }))
    .sort((a, b) => b.weight - a.weight)
}

async function fetchFxRates(currencyCode) {
  if (currencyCode === 'CNY') return null

  const url = `https://api.frankfurter.app/${DATA_START}..?from=${currencyCode}&to=CNY`
  const payload = await fetchJson(url)
  const rates = Object.entries(payload?.rates || {})
    .map(([date, value]) => ({ date, value: Number(value.CNY) }))
    .filter((point) => point.date && Number.isFinite(point.value))
    .sort((a, b) => a.date.localeCompare(b.date))

  return rates.length ? rates : null
}

function rateForDate(rates, date, cursorState) {
  if (!rates?.length) return null

  while (cursorState.index + 1 < rates.length && rates[cursorState.index + 1].date <= date) {
    cursorState.index += 1
  }

  if (rates[cursorState.index].date > date) return rates[0].value
  return rates[cursorState.index].value
}

function convertToCny(history, currencyCode, fxRates) {
  if (currencyCode === 'CNY') return history
  if (!fxRates?.length) return []

  const cursorState = { index: 0 }
  return history
    .map((point) => {
      const rate = rateForDate(fxRates, point.date, cursorState)
      if (!rate) return null
      return {
        date: point.date,
        value: point.value * rate,
      }
    })
    .filter(Boolean)
}

function countBy(items, getter) {
  return items.reduce((counts, item) => {
    const key = getter(item) || '未分类'
    counts[key] = (counts[key] || 0) + 1
    return counts
  }, {})
}

function intervalValue(metrics, periodKey, key) {
  const value = metrics?.intervals?.[periodKey]?.[key]
  return Number.isFinite(value) ? value : null
}

function currencyImpact(localMetrics, cnyMetrics) {
  const impact = {}

  for (const period of PERIODS) {
    const localReturn = intervalValue(localMetrics, period.key, 'totalReturn')
    const cnyReturn = intervalValue(cnyMetrics, period.key, 'totalReturn')
    impact[period.key] =
      Number.isFinite(localReturn) && Number.isFinite(cnyReturn) ? cnyReturn - localReturn : null
  }

  return impact
}

function recommendationScore(fund) {
  const metrics = fund.cnyMetrics
  const oneYear = metrics?.intervals?.['1y']
  const sixMonth = metrics?.intervals?.['6m']
  const basis = oneYear || sixMonth

  if (!basis || !Number.isFinite(basis.annualizedReturn)) return -Infinity

  const drawdown = Math.abs(basis.maxDrawdown ?? 0.4)
  const recoveryDays = basis.drawdown?.recoveryDays ?? basis.drawdown?.unrecoveredDays ?? 540
  const sharpe = Number.isFinite(basis.sharpe) ? basis.sharpe : 0
  const feeRecoveryRate = metrics?.rollingFeeRecovery?.successRate ?? 0
  const historyBonus = metrics.pointCount > 240 ? 0.08 : 0
  const riskPenalty = Math.max(0, (Number(fund.riskRating || 0) - 4) * 0.05)

  return (
    basis.annualizedReturn * 2.2 +
    sharpe * 0.18 -
    drawdown * 1.25 -
    Math.min(recoveryDays, 720) / 720 * 0.45 +
    feeRecoveryRate * 0.28 +
    historyBonus -
    riskPenalty
  )
}

function isTransferablePublicFund(fund) {
  return fund?.fundType === 'cmf' && /^C\d+$/.test(fund.isin || '') && Boolean(fundCodeFromCmf(fund))
}

function buildRecommendations(funds) {
  return funds
    .filter((fund) => isTransferablePublicFund(fund) && fund.cnyMetrics?.pointCount >= 80)
    .map((fund) => ({
      id: fund.id,
      score: recommendationScore(fund),
    }))
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
}

async function main() {
  await mkdir(resolve(ROOT, 'public/data'), { recursive: true })

  console.log('Fetching Standard Chartered fund list...')
  const rawList = await fetchJson(SC_LIST_URL, {
    headers: {
      Authorization: SC_AUTH,
    },
  })

  const sourceInfo = rawList[0] || {}
  const categories = rawList.slice(1)
  const allFunds = categories.find((category) => category['category-type'] === 'all')?.funds || []
  const onshoreDisclosure = await fetchStandardCharteredOnshoreDisclosure().catch((error) => ({
    url: SC_ONSHORE_FUND_URL,
    currentMonth: chinaYearMonth(),
    activeDiscountMonths: [...currentFeeDiscountMonths()],
    byCode: {},
    feeDiscountNotices: [],
    error: error.message,
  }))
  const fundDirectory = await fetchEastmoneyFundDirectory().catch(() => [])

  console.log(`Fetching histories for ${allFunds.length} funds since ${DATA_START}...`)
  let completed = 0
  const withHistories = await mapLimit(allFunds, 8, async (fund) => {
    let history = []
    let historySource = 'none'
    let historyError = null
    let holdingProfile = emptyHoldingProfile()
    let growthSeries = []
    let xueqiuReturns = {}
    let rawPurchaseFee = null
    let purchaseFee = buildPurchaseFee(fund, rawPurchaseFee, null)
    const fundCode = fundCodeFromCmf(fund)
    const onshoreFund = fundCode ? onshoreDisclosure.byCode[fundCode] : null

    try {
      if (fund['fund-type'] === 'qdmf') {
        const [chartResult, profileResult] = await Promise.allSettled([
          fetchStandardCharteredChart(fund),
          fetchStandardCharteredProfile(fund),
        ])
        history = chartResult.status === 'fulfilled' ? chartResult.value : []
        holdingProfile = profileResult.status === 'fulfilled' ? profileResult.value : emptyHoldingProfile()
        historyError = chartResult.status === 'rejected' ? chartResult.reason.message : null
        historySource = history.length ? 'standard-chartered-morningstar' : 'none'
      } else if (fund['fund-type'] === 'cmf') {
        const [infoResult, historyResult, growthResult] = await Promise.allSettled([
          fetchDanjuanFundInfo(fundCode),
          fetchDanjuanHistory(fundCode),
          fetchDanjuanGrowth(fundCode),
        ])
        const fundInfo = infoResult.status === 'fulfilled' ? infoResult.value : null
        const profileResult = await fetchDanjuanHoldingProfile(fund, fundCode, fundInfo, fundDirectory)
          .then((value) => ({ status: 'fulfilled', value }))
          .catch((reason) => ({ status: 'rejected', reason }))
        history = historyResult.status === 'fulfilled' ? historyResult.value : []
        holdingProfile = profileResult.status === 'fulfilled' ? profileResult.value : emptyHoldingProfile()
        growthSeries = growthResult.status === 'fulfilled' ? growthResult.value : []
        xueqiuReturns = xueqiuPeriodReturns(fundInfo)
        rawPurchaseFee = parseDanjuanPurchaseFee(fundInfo)
        historyError = historyResult.status === 'rejected' ? historyResult.reason.message : null
        historySource = history.length ? 'xueqiu-danjuan' : 'none'
      }
      purchaseFee = buildPurchaseFee(fund, rawPurchaseFee, onshoreFund)
    } catch (error) {
      historyError = error.message
    }

    completed += 1
    if (completed % 25 === 0 || completed === allFunds.length) {
      console.log(`  ${completed}/${allFunds.length}`)
    }

    return {
      fund,
      history,
      historySource,
      historyError,
      holdingProfile,
      growthSeries,
      xueqiuReturns,
      purchaseFee,
    }
  })

  const currencyCodes = [
    ...new Set(withHistories.map(({ fund }) => CURRENCY_CODES[fund.currency]).filter((code) => code && code !== 'CNY')),
  ]

  console.log(`Fetching FX history for ${currencyCodes.join(', ') || 'none'}...`)
  const fxPairs = await mapLimit(currencyCodes, 3, async (code) => [code, await fetchFxRates(code).catch(() => null)])
  const fxRates = Object.fromEntries(fxPairs)

  const funds = withHistories.map(({ fund, history, historySource, historyError, holdingProfile, growthSeries, xueqiuReturns, purchaseFee }) => {
    const currencyCode = CURRENCY_CODES[fund.currency] || fund.currency || ''
    const returnHistory = returnHistoryFromGrowth(growthSeries)
    const metricHistory = returnHistory.length >= 2 ? returnHistory : history
    const cnyHistory = convertToCny(history, currencyCode, fxRates[currencyCode])
    const cnyMetricHistory = convertToCny(metricHistory, currencyCode, fxRates[currencyCode])
    const feeRate = Number.isFinite(purchaseFee?.effectiveRate) ? purchaseFee.effectiveRate : null
    const localMetrics = alignIntervalReturnsWithXueqiu(computeFundMetrics(metricHistory, feeRate), xueqiuReturns)
    const cnyMetrics = alignIntervalReturnsWithXueqiu(computeFundMetrics(cnyMetricHistory, feeRate), xueqiuReturns)
    const id = `${fund.isin}-${fund.currency}`
    const fundCode = fundCodeFromCmf(fund)
    const latestLocalPoint = history.at(-1)
    const nav = fund['fund-type'] === 'cmf' && Number.isFinite(latestLocalPoint?.value)
      ? latestLocalPoint.value
      : Number(fund.nav)
    const navDate = fund['fund-type'] === 'cmf' && latestLocalPoint?.date
      ? latestLocalPoint.date
      : fund['nav-date'] || ''

    return {
      id,
      name: fund.name || '',
      isin: fund.isin || '',
      fundType: fund['fund-type'] || '',
      typeLabel: classifyType(fund['fund-type']),
      assetClass: fund['asset-class'] || '',
      sector: fund.sector || '',
      house: fund.house || '',
      currency: fund.currency || '',
      currencyCode,
      nav: Number.isFinite(nav) ? nav : null,
      navDate,
      riskRating: Number.isFinite(Number(fund['risk-rating'])) ? Number(fund['risk-rating']) : null,
      morningstarRating: Number.isFinite(Number(fund['morningstar-rating']))
        ? Number(fund['morningstar-rating'])
        : null,
      isOnline: fund['is-online'] === 'true',
      fundSelect: fund['si-fund-select'] === 'yes',
      listedPerformance: fund.performance || {},
      historySource,
      historyError,
      holdingProfile,
      purchaseFee,
      links: buildFundLinks(fund, fundCode),
      historyLocal: packHistory(history),
      historyCny: currencyCode === 'CNY' ? null : packHistory(cnyHistory),
      returnHistoryLocal: returnHistory.length >= 2 ? packHistory(metricHistory) : null,
      returnHistoryCny: currencyCode === 'CNY' ? null : packHistory(cnyMetricHistory),
      growthSeries: packGrowthSeries(growthSeries),
      xueqiuReturns,
      localMetrics,
      cnyMetrics,
      currencyImpact: currencyCode === 'CNY' ? {} : currencyImpact(localMetrics, cnyMetrics),
      fxAdjusted: currencyCode === 'CNY' || cnyMetricHistory.length > 0,
    }
  })

  const recommendations = buildRecommendations(funds)
  const summary = {
    total: funds.length,
    withHistory: funds.filter((fund) => fund.localMetrics.pointCount > 1).length,
    withFxAdjusted: funds.filter((fund) => fund.fxAdjusted).length,
    withCurrentFeeDiscount: funds.filter((fund) => fund.purchaseFee?.hasCurrentDiscount).length,
    withPurchaseFee: funds.filter((fund) => Number.isFinite(fund.purchaseFee?.effectiveRate)).length,
    byType: countBy(funds, (fund) => fund.typeLabel),
    byCurrency: countBy(funds, (fund) => fund.currency),
    byAssetClass: countBy(funds, (fund) => fund.assetClass),
    bySector: countBy(funds, (fund) => fund.sector),
  }

  const output = {
    generatedAt: new Date().toISOString(),
    range: {
      start: DATA_START,
      end: DATA_END,
    },
    sourceInfo,
    sources: {
      standardCharteredList: SC_LIST_URL,
      standardCharteredOnshoreFundSelection: SC_ONSHORE_FUND_URL,
      standardCharteredGraphql: SC_GRAPHQL_URL,
      xueqiuFund: DANJUAN_FUND_URL,
      xueqiuApi: DANJUAN_API_URL,
      danjuanFund: DANJUAN_FUND_URL,
      tiantianFund: TIANTIAN_H5_FUND_URL,
      tiantianMainApi: TIANTIAN_MAIN_URL,
      eastmoneyFundDirectory: EASTMONEY_FUND_CODE_URL,
      fx: 'https://www.frankfurter.app/',
    },
    onshoreDisclosure: {
      url: onshoreDisclosure.url,
      currentMonth: onshoreDisclosure.currentMonth,
      activeDiscountMonths: onshoreDisclosure.activeDiscountMonths,
      currentFeeDiscountCodes: funds
        .filter((fund) => fund.purchaseFee?.hasCurrentDiscount)
        .map((fund) => fund.name.match(/\d{6}/)?.[0] || fund.isin),
      feeDiscountNotices: onshoreDisclosure.feeDiscountNotices,
      error: onshoreDisclosure.error || null,
    },
    periods: PERIODS,
    summary,
    categories: categories.map((category) => ({
      type: category['category-type'],
      name: category['category-name'],
      count: category.funds?.length || 0,
    })),
    recommendations,
    funds,
  }

  const outPath = resolve(ROOT, 'public/data/funds.json')
  await writeFile(outPath, `${JSON.stringify(output)}\n`, 'utf8')
  console.log(`Wrote ${outPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
