'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3210);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const ITEM_NAME_CACHE_FILE = path.join(DATA_DIR, 'item-name-cache.json');
const SNAPSHOT_CACHE_FILE = path.join(DATA_DIR, 'market-snapshot-cache.json');
const WALLET_FILE = path.join(DATA_DIR, 'wallet-balance.json');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150 Safari/537.36 SteamFlipTracker/1.1.1';
const STEAM_BASE = 'https://steamcommunity.com';
const SNAPSHOT_TTL_MS = 10 * 60 * 1000;

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJsonAtomic(file, value) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

let itemNameCache = loadJson(ITEM_NAME_CACHE_FILE, {});
let snapshotCache = loadJson(SNAPSHOT_CACHE_FILE, {});
let walletState = loadJson(WALLET_FILE, {
  balance: null,
  currency: 'EUR',
  source: 'unset',
  updatedAt: null
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    ...extraHeaders
  });
  res.end(body);
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
  })[ext] || 'application/octet-stream';
}

function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const resolved = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(resolved, (error, data) => {
    if (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 500);
      res.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }
    res.writeHead(200, {
      'Content-Type': mimeType(resolved),
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

async function readJsonBody(req, maxBytes = 16_384) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) {
        reject(new Error('Request body is too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function steamFetch(url, options = {}, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20_000);
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          'Accept-Language': 'en-GB,en;q=0.9',
          Accept: '*/*',
          ...(options.headers || {})
        }
      });
      clearTimeout(timeout);

      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 2_500 * (attempt + 1);
        lastError = new Error(`Steam returned HTTP ${response.status}`);
        if (attempt < retries) {
          await sleep(wait);
          continue;
        }
      }

      if (!response.ok) throw new Error(`Steam returned HTTP ${response.status}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(1_500 * (attempt + 1));
    }
  }
  throw lastError || new Error('Steam request failed');
}

function parseLocalisedPrice(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;

  let cleaned = value.trim().replace(/[^0-9,.-]/g, '');
  if (!cleaned) return null;

  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  if (lastComma > lastDot) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else {
    cleaned = cleaned.replace(/,/g, '');
  }

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseVolume(value) {
  if (typeof value === 'number') return Math.max(0, Math.round(value));
  if (typeof value !== 'string') return 0;
  const digits = value.replace(/\D/g, '');
  return digits ? Number(digits) : 0;
}

function feeForSellerCents(sellerCents, steamFeeRate, publisherFeeRate) {
  if (sellerCents <= 0) return { steamFee: 0, publisherFee: 0, totalFee: 0 };
  const steamFee = Math.max(1, Math.floor(sellerCents * steamFeeRate));
  const publisherFee = publisherFeeRate > 0
    ? Math.max(1, Math.floor(sellerCents * publisherFeeRate))
    : 0;
  return { steamFee, publisherFee, totalFee: steamFee + publisherFee };
}

function sellerReceivesFromBuyerPrice(buyerPrice, steamFeeRate = 0.05, publisherFeeRate = 0.10) {
  const buyerCents = Math.max(0, Math.round(buyerPrice * 100));
  for (let sellerCents = buyerCents; sellerCents >= 0; sellerCents -= 1) {
    const fees = feeForSellerCents(sellerCents, steamFeeRate, publisherFeeRate);
    if (sellerCents + fees.totalFee <= buyerCents) {
      return {
        sellerReceives: sellerCents / 100,
        fees: fees.totalFee / 100,
        steamFee: fees.steamFee / 100,
        publisherFee: fees.publisherFee / 100
      };
    }
  }
  return { sellerReceives: 0, fees: buyerCents / 100, steamFee: 0, publisherFee: 0 };
}

function makeMarketUrl(hashName) {
  return `${STEAM_BASE}/market/listings/753/${encodeURIComponent(hashName)}`;
}

function searchResultSellPrice(result) {
  if (Number(result.sell_price) > 0) return Number(result.sell_price) / 100;
  return parseLocalisedPrice(result.sell_price_text);
}

async function getSearchPool({ pages, sortColumn, sortDir, poolName }) {
  const all = [];
  let start = 0;

  for (let page = 0; page < pages; page += 1) {
    const url = new URL(`${STEAM_BASE}/market/search/render/`);
    url.searchParams.set('norender', '1');
    url.searchParams.set('start', String(start));
    url.searchParams.set('count', '100');
    url.searchParams.set('query', '');
    url.searchParams.set('search_descriptions', '0');
    url.searchParams.set('sort_column', sortColumn);
    url.searchParams.set('sort_dir', sortDir);
    url.searchParams.set('appid', '753');
    url.searchParams.set('country', 'DE');
    url.searchParams.set('currency', '3');
    url.searchParams.set('l', 'english');
    url.searchParams.append('category_753_item_class[]', 'tag_item_class_2');

    const response = await steamFetch(url);
    const data = await response.json();
    if (!data || !data.success || !Array.isArray(data.results)) {
      throw new Error(`Steam returned an unexpected ${poolName} search response`);
    }

    const results = data.results.map(item => ({ ...item, discoveryPool: poolName }));
    all.push(...results);
    const advance = results.length || Number(data.pagesize || 10);
    start += Math.max(1, advance);
    if (start >= Number(data.total_count || 0) || results.length === 0) break;
    await sleep(900);
  }

  return all;
}

function interleavePools(pools) {
  const merged = [];
  const maxLength = Math.max(0, ...pools.map(pool => pool.length));
  for (let index = 0; index < maxLength; index += 1) {
    for (const pool of pools) {
      if (pool[index]) merged.push(pool[index]);
    }
  }

  const seen = new Set();
  return merged.filter(result => {
    const hashName = result.hash_name || result.asset_description?.market_hash_name;
    if (!hashName || seen.has(hashName)) return false;
    seen.add(hashName);
    return true;
  });
}

async function getSearchResults({ pages }) {
  const popular = await getSearchPool({
    pages,
    sortColumn: 'popular',
    sortDir: 'desc',
    poolName: 'popular'
  });
  await sleep(1_000);
  const cheap = await getSearchPool({
    pages,
    sortColumn: 'price',
    sortDir: 'asc',
    poolName: 'cheap'
  });
  return interleavePools([popular, cheap]);
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&nbsp;|&ensp;|&emsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function htmlToMarketText(html, removeScripts = true) {
  let value = String(html || '');
  if (removeScripts) {
    value = value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  }
  value = value
    .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|td|th|h[1-6]|section|article|table|thead|tbody)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeHtmlEntities(value)
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

const CURRENCY_PREFIX = '(?:[A-Z]{3}\\s*)?(?:R\\$\\s*)?[€£$¥₹₽₩₺₴₫₱]?\\s*';
const PRICE_NUMBER = '[0-9]+(?:[.,][0-9]{1,2})?';

function firstPriceQuantity(section, expectedPrice) {
  if (!section || !(expectedPrice > 0)) return 0;
  const regex = new RegExp(`${CURRENCY_PREFIX}(${PRICE_NUMBER})\\s+([0-9][0-9.,]*)`, 'gi');
  for (const match of section.matchAll(regex)) {
    const price = parseLocalisedPrice(match[1]);
    if (price !== null && Math.abs(price - expectedPrice) < 0.001) {
      return parseVolume(match[2]);
    }
  }
  return 0;
}

function parseListingOrderBookFromText(text) {
  const sellRegex = new RegExp(`([0-9][0-9.,]*)\\s+for sale starting at\\s+(${CURRENCY_PREFIX}${PRICE_NUMBER})`, 'i');
  const buyRegex = new RegExp(`([0-9][0-9.,]*)\\s+requests? to buy at\\s+(${CURRENCY_PREFIX}${PRICE_NUMBER})\\s+or lower`, 'i');
  const sellMatch = sellRegex.exec(text);
  const buyMatch = buyRegex.exec(text);
  if (!sellMatch || !buyMatch) return null;

  const lowestSell = parseLocalisedPrice(sellMatch[2]);
  const highestBuy = parseLocalisedPrice(buyMatch[2]);
  if (!(lowestSell > 0) || !(highestBuy > 0)) return null;

  const sellSection = text.slice(sellMatch.index + sellMatch[0].length, buyMatch.index);
  const buySection = text.slice(buyMatch.index + buyMatch[0].length);
  return {
    highestBuy,
    lowestSell,
    buyDepthAtTop: firstPriceQuantity(buySection, highestBuy),
    sellDepthAtTop: firstPriceQuantity(sellSection, lowestSell),
    totalBuyOrders: parseVolume(buyMatch[1]),
    totalSellOrders: parseVolume(sellMatch[1]),
    source: 'listing-html'
  };
}

function parseListingOrderBook(html) {
  const visibleText = htmlToMarketText(html, true);
  const visibleResult = parseListingOrderBookFromText(visibleText);
  if (visibleResult) return visibleResult;

  // Some Steam variants place the same rendered strings in hydration data.
  const allText = htmlToMarketText(html, false);
  return parseListingOrderBookFromText(allText);
}

function extractItemNameId(html) {
  const patterns = [
    /Market_LoadOrderSpread\(\s*(\d+)\s*\)/i,
    /item_nameid["']?\s*[:=]\s*["']?(\d+)/i,
    /ItemActivityTicker\.Start\(\s*(\d+)\s*\)/i,
    /itemNameId["']?\s*[:=]\s*["']?(\d+)/i
  ];
  const match = patterns.map(pattern => String(html || '').match(pattern)).find(Boolean);
  return match?.[1] || null;
}

async function fetchListingPage(hashName) {
  const url = new URL(makeMarketUrl(hashName));
  url.searchParams.set('l', 'english');
  url.searchParams.set('country', 'DE');
  url.searchParams.set('currency', '3');
  const response = await steamFetch(url, {
    headers: { Referer: `${STEAM_BASE}/market/` }
  });
  const html = await response.text();
  const itemNameId = extractItemNameId(html);
  const histogram = parseListingOrderBook(html);

  if (itemNameId) {
    itemNameCache[hashName] = {
      itemNameId,
      updatedAt: new Date().toISOString()
    };
    saveJsonAtomic(ITEM_NAME_CACHE_FILE, itemNameCache);
  }

  return { itemNameId, histogram };
}

function bestGraphDepth(graph, mode) {
  if (!Array.isArray(graph) || graph.length === 0) return 0;
  const rows = graph
    .filter(row => Array.isArray(row) && Number.isFinite(Number(row[0])))
    .map(row => ({ price: Number(row[0]), depth: Number(row[1]) || 0 }));
  if (!rows.length) return 0;
  const bestPrice = mode === 'buy'
    ? Math.max(...rows.map(row => row.price))
    : Math.min(...rows.map(row => row.price));
  return rows.find(row => row.price === bestPrice)?.depth || 0;
}

async function getHistogram(hashName, itemNameId) {
  const listingUrl = makeMarketUrl(hashName);
  const url = new URL(`${STEAM_BASE}/market/itemordershistogram`);
  url.searchParams.set('country', 'DE');
  url.searchParams.set('language', 'english');
  url.searchParams.set('currency', '3');
  url.searchParams.set('item_nameid', String(itemNameId));
  url.searchParams.set('two_factor', '0');

  const response = await steamFetch(url, {
    headers: {
      Referer: listingUrl,
      'X-Requested-With': 'XMLHttpRequest'
    }
  });
  const data = await response.json();
  if (!data || !(data.success === 1 || data.success === true)) {
    throw new Error('Steam returned an unexpected order-book response');
  }

  return {
    highestBuy: Number(data.highest_buy_order || 0) / 100,
    lowestSell: Number(data.lowest_sell_order || 0) / 100,
    buyDepthAtTop: bestGraphDepth(data.buy_order_graph, 'buy'),
    sellDepthAtTop: bestGraphDepth(data.sell_order_graph, 'sell'),
    totalBuyOrders: parseVolume(String(data.buy_order_summary || '')),
    totalSellOrders: parseVolume(String(data.sell_order_summary || '')),
    source: 'itemordershistogram'
  };
}

async function getPriceOverview(hashName) {
  const url = new URL(`${STEAM_BASE}/market/priceoverview/`);
  url.searchParams.set('country', 'DE');
  url.searchParams.set('currency', '3');
  url.searchParams.set('appid', '753');
  url.searchParams.set('market_hash_name', hashName);

  const response = await steamFetch(url, {
    headers: { Referer: makeMarketUrl(hashName) }
  }, 1);
  const data = await response.json();
  if (!data || data.success === false) throw new Error('Steam price overview was unavailable');
  return {
    volume: parseVolume(data.volume),
    medianPrice: parseLocalisedPrice(data.median_price),
    lowestPrice: parseLocalisedPrice(data.lowest_price)
  };
}

function getCachedSnapshot(hashName) {
  const cached = snapshotCache[hashName];
  if (!cached?.updatedAt) return null;
  const age = Date.now() - Date.parse(cached.updatedAt);
  return Number.isFinite(age) && age < SNAPSHOT_TTL_MS ? cached : null;
}

function saveSnapshot(hashName, snapshot) {
  snapshotCache[hashName] = { ...snapshot, updatedAt: new Date().toISOString() };
  const entries = Object.entries(snapshotCache)
    .filter(([, value]) => Date.now() - Date.parse(value.updatedAt || 0) < 24 * 60 * 60 * 1000)
    .slice(-500);
  snapshotCache = Object.fromEntries(entries);
  saveJsonAtomic(SNAPSHOT_CACHE_FILE, snapshotCache);
}

async function getMarketSnapshot(hashName, includeOverview = false) {
  const cached = getCachedSnapshot(hashName);
  if (cached && (!includeOverview || cached.overview)) return cached;

  let itemNameId = cached?.itemNameId || itemNameCache[hashName]?.itemNameId || null;
  let histogram = cached?.histogram || null;
  let listingPage = null;
  let histogramError = null;

  if (!histogram && itemNameId) {
    try {
      histogram = await getHistogram(hashName, itemNameId);
    } catch (error) {
      histogramError = error;
    }
  }

  if (!histogram) {
    listingPage = await fetchListingPage(hashName);
    itemNameId = listingPage.itemNameId || itemNameId;

    if (itemNameId && !histogramError) {
      try {
        histogram = await getHistogram(hashName, itemNameId);
      } catch (error) {
        histogramError = error;
      }
    }

    // Market Beta no longer exposes item_nameid on every listing, but it does
    // render the live best buy/sell rows directly into the listing page.
    histogram = histogram || listingPage.histogram;
  }

  if (!histogram) {
    const details = histogramError ? ` (${histogramError.message})` : '';
    throw new Error(`Could not read Steam order-book data from the histogram or listing page${details}`);
  }

  const snapshot = {
    itemNameId,
    histogram,
    overview: cached?.overview || null
  };
  if (includeOverview && !snapshot.overview) snapshot.overview = await getPriceOverview(hashName);
  saveSnapshot(hashName, snapshot);
  return snapshot;
}

function scoreCandidate(candidate) {
  const profitScore = clamp(candidate.profit * 350, 0, 30);
  const roiScore = clamp(candidate.roi * 30, 0, 30);
  const volumeScore = clamp(Math.log10(candidate.volume + 1) * 12, 0, 25);
  const buyDepthPenalty = clamp(Math.log10(candidate.buyDepthAtTop + 1) * 4, 0, 10);
  const sellDepthPenalty = clamp(Math.log10(candidate.sellDepthAtTop + 1) * 2, 0, 5);
  return Math.round(clamp(profitScore + roiScore + volumeScore - buyDepthPenalty - sellDepthPenalty, 0, 100));
}

function makeRejection(reason, item, metrics = {}) {
  return {
    reason,
    name: item.name,
    hashName: item.hashName,
    marketUrl: makeMarketUrl(item.hashName),
    ...metrics
  };
}

async function analyseItem(result, settings) {
  const hashName = result.hash_name || result.asset_description?.market_hash_name;
  const name = result.name || result.asset_description?.name || hashName;
  const type = result.asset_description?.type || '';
  const item = { hashName, name, type };

  if (!settings.includeFoils && /foil/i.test(`${name} ${type}`)) {
    return { rejection: makeRejection('foil excluded', item) };
  }

  const searchSellPrice = searchResultSellPrice(result);
  if (searchSellPrice !== null && searchSellPrice < 0.04) {
    return { rejection: makeRejection('selling price too low for fees', item, { currentLowestSell: searchSellPrice }) };
  }

  const firstSnapshot = await getMarketSnapshot(hashName, false);
  const histogram = firstSnapshot.histogram;
  const highestBuy = histogram.highestBuy;
  const lowestSell = histogram.lowestSell || searchSellPrice || 0;
  if (!(highestBuy > 0) || !(lowestSell > 0)) {
    return { rejection: makeRejection('missing live buy or sell orders', item) };
  }

  const buyPrice = Number((highestBuy + 0.01).toFixed(2));
  const sellPrice = Number(Math.max(0.03, lowestSell - settings.sellUndercut).toFixed(2));
  if (buyPrice >= sellPrice) {
    return { rejection: makeRejection('no usable spread', item, { buyPrice, sellPrice }) };
  }

  const feeResult = sellerReceivesFromBuyerPrice(sellPrice, settings.steamFeeRate, settings.publisherFeeRate);
  const profit = Number((feeResult.sellerReceives - buyPrice).toFixed(2));
  const roi = buyPrice > 0 ? profit / buyPrice : 0;
  const metrics = {
    buyPrice,
    sellPrice,
    sellerReceives: feeResult.sellerReceives,
    profit,
    roi,
    currentHighestBuy: highestBuy,
    currentLowestSell: lowestSell
  };

  if (buyPrice > settings.maxBuyPrice) {
    return { rejection: makeRejection('above maximum buy price', item, metrics) };
  }
  if (settings.walletBalance > 0 && buyPrice > settings.walletBalance) {
    return { rejection: makeRejection('above wallet balance', item, metrics) };
  }
  if (profit < settings.minProfit) {
    return { rejection: makeRejection('profit below minimum', item, metrics) };
  }
  if (roi < settings.minRoi) {
    return { rejection: makeRejection('ROI below minimum', item, metrics) };
  }

  let overview = firstSnapshot.overview;
  if (!overview) {
    try {
      overview = (await getMarketSnapshot(hashName, true)).overview;
    } catch {
      overview = { volume: 0, medianPrice: null, lowestPrice: null };
    }
  }
  const volume = overview?.volume || 0;
  if (volume < settings.minVolume) {
    return { rejection: makeRejection('volume below minimum', item, { ...metrics, volume }) };
  }

  const affordableQty = settings.walletBalance > 0 ? Math.floor(settings.walletBalance / buyPrice) : null;
  const candidate = {
    name,
    hashName,
    type,
    discoveryPool: result.discoveryPool || 'unknown',
    image: result.asset_description?.icon_url
      ? `https://community.fastly.steamstatic.com/economy/image/${result.asset_description.icon_url}/96fx96f`
      : '',
    marketUrl: makeMarketUrl(hashName),
    currentHighestBuy: highestBuy,
    currentLowestSell: lowestSell,
    buyPrice,
    sellPrice,
    sellerReceives: feeResult.sellerReceives,
    fees: feeResult.fees,
    profit,
    roi,
    volume,
    medianPrice: overview?.medianPrice ?? null,
    sellListings: Number(result.sell_listings || 0),
    buyDepthAtTop: histogram.buyDepthAtTop,
    sellDepthAtTop: histogram.sellDepthAtTop,
    totalBuyOrders: histogram.totalBuyOrders,
    totalSellOrders: histogram.totalSellOrders,
    orderBookSource: histogram.source || 'unknown',
    affordableQty
  };
  candidate.score = scoreCandidate(candidate);
  return { candidate };
}

function rejectionDistance(entry, settings) {
  switch (entry.reason) {
    case 'profit below minimum': return Math.max(0, settings.minProfit - (entry.profit || 0));
    case 'ROI below minimum': return Math.max(0, settings.minRoi - (entry.roi || 0));
    case 'volume below minimum': return Math.max(0, settings.minVolume - (entry.volume || 0)) / 100;
    case 'above maximum buy price': return Math.max(0, (entry.buyPrice || 0) - settings.maxBuyPrice);
    default: return 999;
  }
}

async function runScan(searchParams) {
  const pages = clamp(Number(searchParams.get('pages') || 3), 1, 10);
  const limit = clamp(Number(searchParams.get('limit') || 60), 1, 200);
  const delayMs = clamp(Number(searchParams.get('delayMs') || 1800), 900, 10_000);
  const minProfit = clamp(Number(searchParams.get('minProfit') || 0.01), 0, 10);
  const minRoi = clamp(Number(searchParams.get('minRoi') || 10) / 100, 0, 10);
  const minVolume = clamp(Number(searchParams.get('minVolume') || 0), 0, 1_000_000);
  const maxBuyPrice = clamp(Number(searchParams.get('maxBuyPrice') || 0.25), 0.01, 1_000);
  const walletBalance = clamp(Number(searchParams.get('walletBalance') || walletState.balance || 0), 0, 1_000_000);
  const includeFoils = searchParams.get('includeFoils') === 'true';
  const publisherFeeRate = clamp(Number(searchParams.get('publisherFee') || 10) / 100, 0, 1);
  const steamFeeRate = clamp(Number(searchParams.get('steamFee') || 5) / 100, 0, 1);
  const sellUndercut = clamp(Number(searchParams.get('sellUndercut') || 0.01), 0, 1);

  const settings = {
    includeFoils,
    publisherFeeRate,
    steamFeeRate,
    sellUndercut,
    minProfit,
    minRoi,
    minVolume,
    maxBuyPrice,
    walletBalance
  };

  const rawResults = await getSearchResults({ pages });
  const candidates = [];
  const rejections = [];
  const errors = [];
  const sourceItems = rawResults.slice(0, limit);

  for (let index = 0; index < sourceItems.length; index += 1) {
    const item = sourceItems[index];
    const hashName = item.hash_name || item.asset_description?.market_hash_name || `item-${index}`;
    try {
      const result = await analyseItem(item, settings);
      if (result.candidate) candidates.push(result.candidate);
      if (result.rejection) rejections.push(result.rejection);
    } catch (error) {
      errors.push({ item: hashName, message: error.message });
    }
    if (index < sourceItems.length - 1) await sleep(delayMs);
  }

  candidates.sort((a, b) => b.score - a.score || b.profit - a.profit || b.volume - a.volume);
  const rejectionCounts = rejections.reduce((counts, rejection) => {
    counts[rejection.reason] = (counts[rejection.reason] || 0) + 1;
    return counts;
  }, {});
  const nearMisses = rejections
    .filter(entry => ['profit below minimum', 'ROI below minimum', 'volume below minimum', 'above maximum buy price'].includes(entry.reason))
    .sort((a, b) => rejectionDistance(a, settings) - rejectionDistance(b, settings))
    .slice(0, 12);

  return {
    generatedAt: new Date().toISOString(),
    discovered: rawResults.length,
    scanned: sourceItems.length,
    matched: candidates.length,
    candidates,
    nearMisses,
    rejectionCounts,
    warnings: errors.slice(0, 20),
    settings: {
      pages,
      limit,
      delayMs,
      minProfit,
      minRoi: minRoi * 100,
      minVolume,
      maxBuyPrice,
      walletBalance,
      includeFoils,
      publisherFee: publisherFeeRate * 100,
      steamFee: steamFeeRate * 100,
      sellUndercut
    }
  };
}

function updateWallet(payload, sourceFallback = 'manual') {
  const balance = Number(payload.balance);
  if (!Number.isFinite(balance) || balance < 0 || balance > 1_000_000) {
    throw new Error('Balance must be a valid non-negative number');
  }
  walletState = {
    balance: Number(balance.toFixed(2)),
    currency: typeof payload.currency === 'string' ? payload.currency.slice(0, 8) : 'EUR',
    source: typeof payload.source === 'string' ? payload.source.slice(0, 64) : sourceFallback,
    updatedAt: new Date().toISOString()
  };
  saveJsonAtomic(WALLET_FILE, walletState);
  return walletState;
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    });
    res.end();
    return;
  }

  if (requestUrl.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, version: '1.1.1' });
    return;
  }

  if (requestUrl.pathname === '/api/wallet') {
    if (req.method === 'GET') {
      sendJson(res, 200, walletState);
      return;
    }
    if (req.method === 'POST') {
      try {
        const payload = await readJsonBody(req);
        sendJson(res, 200, updateWallet(payload, 'local-app'));
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return;
    }
    sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, POST, OPTIONS' });
    return;
  }

  if (requestUrl.pathname === '/api/fees') {
    const gross = Number(requestUrl.searchParams.get('gross') || 0);
    const steamFee = Number(requestUrl.searchParams.get('steamFee') || 5) / 100;
    const publisherFee = Number(requestUrl.searchParams.get('publisherFee') || 10) / 100;
    sendJson(res, 200, sellerReceivesFromBuyerPrice(gross, steamFee, publisherFee));
    return;
  }

  if (requestUrl.pathname === '/api/scan') {
    try {
      const result = await runScan(requestUrl.searchParams);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 502, {
        error: error.message || 'Scan failed',
        hint: 'Steam may be rate-limiting public market requests. Wait before scanning again, raise the delay, or use the manual calculator.'
      });
    }
    return;
  }

  serveStatic(req, res, requestUrl.pathname);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Steam Flip Tracker is running at http://${HOST}:${PORT}`);
    console.log('Press Ctrl+C to stop it.');
  });
}

module.exports = {
  parseListingOrderBook,
  parseLocalisedPrice,
  sellerReceivesFromBuyerPrice
};
