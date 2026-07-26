'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3210);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'item-name-cache.json');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150 Safari/537.36 SteamFlipTracker/1.0';
const STEAM_BASE = 'https://steamcommunity.com';

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

let itemNameCache = loadCache();

function saveCache() {
  const temp = `${CACHE_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(itemNameCache, null, 2));
  fs.renameSync(temp, CACHE_FILE);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
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
        const wait = 2_500 * (attempt + 1);
        lastError = new Error(`Steam returned HTTP ${response.status}`);
        if (attempt < retries) {
          await sleep(wait);
          continue;
        }
      }

      if (!response.ok) {
        throw new Error(`Steam returned HTTP ${response.status}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(1_500 * (attempt + 1));
      }
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

async function getSearchResults({ pages, sortColumn, sortDir }) {
  const all = [];
  let start = 0;
  let pageSize = 10;

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
    url.searchParams.append('category_753_item_class[]', 'tag_item_class_2');

    const response = await steamFetch(url);
    const data = await response.json();
    if (!data || !data.success || !Array.isArray(data.results)) {
      throw new Error('Steam returned an unexpected search response');
    }

    pageSize = Number(data.pagesize || data.results.length || 10);
    all.push(...data.results);
    start += pageSize;
    if (start >= Number(data.total_count || 0) || data.results.length === 0) break;
    await sleep(1_200);
  }

  const seen = new Set();
  return all.filter(result => {
    const hashName = result.hash_name || result.asset_description?.market_hash_name;
    if (!hashName || seen.has(hashName)) return false;
    seen.add(hashName);
    return true;
  });
}

async function getItemNameId(hashName) {
  const cached = itemNameCache[hashName];
  if (cached?.itemNameId) return cached.itemNameId;

  const marketUrl = makeMarketUrl(hashName);
  const response = await steamFetch(marketUrl, {
    headers: { Referer: `${STEAM_BASE}/market/` }
  });
  const html = await response.text();
  const match = html.match(/Market_LoadOrderSpread\(\s*(\d+)\s*\)/i)
    || html.match(/item_nameid["']?\s*[:=]\s*["']?(\d+)/i);
  if (!match) throw new Error('Could not read the Steam item name ID');

  itemNameCache[hashName] = {
    itemNameId: match[1],
    updatedAt: new Date().toISOString()
  };
  saveCache();
  return match[1];
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

  const buyTablePrice = parseLocalisedPrice(data.buy_order_table?.[0]?.price);
  const sellTablePrice = parseLocalisedPrice(data.sell_order_table?.[0]?.price);
  const highestBuy = buyTablePrice ?? (Number(data.highest_buy_order || 0) / 100);
  const lowestSell = sellTablePrice ?? (Number(data.lowest_sell_order || 0) / 100);

  return {
    highestBuy,
    lowestSell,
    buyOrdersAtTop: Number(data.buy_order_table?.[0]?.count || 0),
    sellOrdersAtTop: Number(data.sell_order_table?.[0]?.count || 0),
    totalBuyOrders: parseVolume(String(data.buy_order_summary || '')),
    totalSellOrders: parseVolume(String(data.sell_order_summary || ''))
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
  return {
    volume: parseVolume(data.volume),
    medianPrice: parseLocalisedPrice(data.median_price),
    lowestPrice: parseLocalisedPrice(data.lowest_price)
  };
}

function scoreCandidate(candidate) {
  const profitScore = clamp(candidate.profit * 350, 0, 30);
  const roiScore = clamp(candidate.roi * 30, 0, 30);
  const volumeScore = clamp(Math.log10(candidate.volume + 1) * 12, 0, 25);
  const queuePenalty = clamp(Math.log10(candidate.buyOrdersAtTop + 1) * 4, 0, 10);
  const sellQueuePenalty = clamp(Math.log10(candidate.sellOrdersAtTop + 1) * 2, 0, 5);
  return Math.round(clamp(profitScore + roiScore + volumeScore - queuePenalty - sellQueuePenalty, 0, 100));
}

async function analyseItem(result, settings) {
  const hashName = result.hash_name || result.asset_description?.market_hash_name;
  const name = result.name || result.asset_description?.name || hashName;
  const type = result.asset_description?.type || '';

  if (!settings.includeFoils && /foil/i.test(`${name} ${type}`)) return null;

  const itemNameId = await getItemNameId(hashName);
  const histogram = await getHistogram(hashName, itemNameId);
  let overview = { volume: 0, medianPrice: null, lowestPrice: null };
  try {
    overview = await getPriceOverview(hashName);
  } catch {
    // Volume is useful but optional. Keep the order-book result.
  }

  const highestBuy = histogram.highestBuy;
  const lowestSell = histogram.lowestSell || overview.lowestPrice || 0;
  if (!(highestBuy > 0) || !(lowestSell > 0)) return null;

  const buyPrice = Number((highestBuy + 0.01).toFixed(2));
  const sellPrice = Number(Math.max(0.03, lowestSell - settings.sellUndercut).toFixed(2));
  if (buyPrice >= sellPrice) return null;

  const feeResult = sellerReceivesFromBuyerPrice(
    sellPrice,
    settings.steamFeeRate,
    settings.publisherFeeRate
  );
  const profit = Number((feeResult.sellerReceives - buyPrice).toFixed(2));
  const roi = buyPrice > 0 ? profit / buyPrice : 0;

  const candidate = {
    name,
    hashName,
    type,
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
    volume: overview.volume,
    medianPrice: overview.medianPrice,
    sellListings: Number(result.sell_listings || 0),
    buyOrdersAtTop: histogram.buyOrdersAtTop,
    sellOrdersAtTop: histogram.sellOrdersAtTop,
    totalBuyOrders: histogram.totalBuyOrders,
    totalSellOrders: histogram.totalSellOrders
  };
  candidate.score = scoreCandidate(candidate);
  return candidate;
}

async function runScan(searchParams) {
  const pages = clamp(Number(searchParams.get('pages') || 3), 1, 10);
  const limit = clamp(Number(searchParams.get('limit') || 25), 1, 100);
  const delayMs = clamp(Number(searchParams.get('delayMs') || 2400), 1200, 10_000);
  const minProfit = clamp(Number(searchParams.get('minProfit') || 0.02), 0, 10);
  const minRoi = clamp(Number(searchParams.get('minRoi') || 20) / 100, 0, 10);
  const minVolume = clamp(Number(searchParams.get('minVolume') || 5), 0, 1_000_000);
  const maxBuyPrice = clamp(Number(searchParams.get('maxBuyPrice') || 0.25), 0.01, 1_000);
  const includeFoils = searchParams.get('includeFoils') === 'true';
  const publisherFeeRate = clamp(Number(searchParams.get('publisherFee') || 10) / 100, 0, 1);
  const steamFeeRate = clamp(Number(searchParams.get('steamFee') || 5) / 100, 0, 1);
  const sellUndercut = clamp(Number(searchParams.get('sellUndercut') || 0.01), 0, 1);

  const settings = {
    includeFoils,
    publisherFeeRate,
    steamFeeRate,
    sellUndercut
  };

  const rawResults = await getSearchResults({ pages, sortColumn: 'popular', sortDir: 'desc' });
  const candidates = [];
  const errors = [];
  const sourceItems = rawResults.slice(0, Math.max(limit * 2, limit));

  for (let index = 0; index < sourceItems.length && candidates.length < limit; index += 1) {
    const item = sourceItems[index];
    const hashName = item.hash_name || item.asset_description?.market_hash_name || `item-${index}`;
    try {
      const candidate = await analyseItem(item, settings);
      if (
        candidate
        && candidate.buyPrice <= maxBuyPrice
        && candidate.profit >= minProfit
        && candidate.roi >= minRoi
        && candidate.volume >= minVolume
      ) {
        candidates.push(candidate);
      }
    } catch (error) {
      errors.push({ item: hashName, message: error.message });
    }
    if (index < sourceItems.length - 1) await sleep(delayMs);
  }

  candidates.sort((a, b) => b.score - a.score || b.profit - a.profit || b.volume - a.volume);
  return {
    generatedAt: new Date().toISOString(),
    scanned: sourceItems.length,
    matched: candidates.length,
    candidates,
    warnings: errors.slice(0, 10),
    settings: {
      pages,
      limit,
      delayMs,
      minProfit,
      minRoi: minRoi * 100,
      minVolume,
      maxBuyPrice,
      includeFoils,
      publisherFee: publisherFeeRate * 100,
      steamFee: steamFeeRate * 100,
      sellUndercut
    }
  };
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (requestUrl.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, version: '1.0.0' });
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
        hint: 'Steam may be rate-limiting public market requests. Wait before scanning again or use the manual calculator.'
      });
    }
    return;
  }

  serveStatic(req, res, requestUrl.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Steam Flip Tracker is running at http://${HOST}:${PORT}`);
  console.log('Press Ctrl+C to stop it.');
});
