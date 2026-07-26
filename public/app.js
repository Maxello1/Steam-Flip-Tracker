'use strict';

const euro = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR' });
const percent = new Intl.NumberFormat('en-GB', { style: 'percent', maximumFractionDigits: 0 });
const storageKey = 'steamFlipTracker.trades.v1';
const balanceKey = 'steamFlipTracker.balance.v1';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

let recommendations = [];
let trades = loadTrades();

function readNumber(selector, fallback = 0) {
  const value = Number($(selector)?.value);
  return Number.isFinite(value) ? value : fallback;
}

function loadTrades() {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function saveTrades() {
  localStorage.setItem(storageKey, JSON.stringify(trades));
  renderTracker();
}

function calculateFeesLocally(gross, steamFeeRate = 0.05, publisherFeeRate = 0.10) {
  const grossCents = Math.max(0, Math.round(gross * 100));
  for (let sellerCents = grossCents; sellerCents >= 0; sellerCents -= 1) {
    if (sellerCents === 0) return { sellerReceives: 0, fees: grossCents / 100 };
    const steamFee = Math.max(1, Math.floor(sellerCents * steamFeeRate));
    const publisherFee = publisherFeeRate > 0 ? Math.max(1, Math.floor(sellerCents * publisherFeeRate)) : 0;
    if (sellerCents + steamFee + publisherFee <= grossCents) {
      return { sellerReceives: sellerCents / 100, fees: (steamFee + publisherFee) / 100 };
    }
  }
  return { sellerReceives: 0, fees: gross };
}

function activateTab(tabName) {
  $$('.tab').forEach(button => button.classList.toggle('active', button.dataset.tab === tabName));
  $$('.tab-panel').forEach(panel => panel.classList.toggle('active', panel.id === tabName));
}

function showStatus(message, type = '') {
  const element = $('#scanStatus');
  element.textContent = message;
  element.className = `status ${type}`.trim();
}

function hideStatus() {
  $('#scanStatus').className = 'status hidden';
}

function scannerParams() {
  const params = new URLSearchParams();
  const fields = ['pages', 'limit', 'maxBuyPrice', 'minProfit', 'minRoi', 'minVolume', 'delayMs', 'sellUndercut', 'steamFee', 'publisherFee'];
  fields.forEach(id => params.set(id, String(readNumber(`#${id}`))));
  params.set('includeFoils', String($('#includeFoils').checked));
  return params;
}

async function scanCards() {
  const button = $('#scanButton');
  button.disabled = true;
  button.textContent = 'Scanning…';
  recommendations = [];
  renderRecommendations();
  showStatus('Reading public Steam market data. The first scan is slower because item IDs are being cached.');

  try {
    const response = await fetch(`/api/scan?${scannerParams()}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.hint || data.error || 'Scan failed');

    recommendations = data.candidates || [];
    renderRecommendations();
    const warningText = data.warnings?.length ? ` ${data.warnings.length} item lookups were skipped.` : '';
    showStatus(`Scanned ${data.scanned} cards and found ${data.matched} matches.${warningText}`, 'success');
  } catch (error) {
    showStatus(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Scan popular cards';
  }
}

function renderRecommendations() {
  const body = $('#recommendationsBody');
  body.innerHTML = '';
  if (!recommendations.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="9">No recommendations loaded. Loosen the filters or try again later if a scan found nothing.</td></tr>';
    return;
  }

  const template = $('#recommendationTemplate');
  recommendations.forEach((item, index) => {
    const row = template.content.cloneNode(true);
    row.querySelector('.score').textContent = item.score;
    const image = row.querySelector('.item-image');
    image.src = item.image || '';
    image.style.visibility = item.image ? 'visible' : 'hidden';
    const link = row.querySelector('.item-link');
    link.href = item.marketUrl;
    link.textContent = item.name;
    row.querySelector('.item-meta').textContent = `${item.buyOrdersAtTop} at top buy · ${item.sellOrdersAtTop} at lowest sell`;
    row.querySelector('.buy-price').textContent = euro.format(item.buyPrice);
    row.querySelector('.sell-price').textContent = euro.format(item.sellPrice);
    row.querySelector('.receive-price').textContent = euro.format(item.sellerReceives);
    const profitCell = row.querySelector('.profit');
    profitCell.textContent = euro.format(item.profit);
    profitCell.classList.add(item.profit > 0 ? 'good' : 'bad');
    const roiCell = row.querySelector('.roi');
    roiCell.textContent = percent.format(item.roi);
    roiCell.classList.add(item.roi > 0 ? 'good' : 'bad');
    row.querySelector('.volume').textContent = item.volume.toLocaleString('en-GB');
    row.querySelector('.add-button').addEventListener('click', () => addRecommendationToTracker(index));
    body.appendChild(row);
  });
}

function addRecommendationToTracker(index) {
  const item = recommendations[index];
  if (!item) return;
  trades.unshift({
    id: crypto.randomUUID(),
    name: item.name,
    marketUrl: item.marketUrl,
    status: 'ordered',
    quantity: 1,
    buyPrice: item.buyPrice,
    targetSellPrice: item.sellPrice,
    actualSellPrice: null,
    steamFeeRate: readNumber('#steamFee', 5) / 100,
    publisherFeeRate: readNumber('#publisherFee', 10) / 100,
    createdAt: new Date().toISOString()
  });
  saveTrades();
  activateTab('tracker');
}

function updateCalculator() {
  const buy = readNumber('#calcBuy');
  const sell = readNumber('#calcSell');
  const steamFeeRate = readNumber('#calcSteamFee', 5) / 100;
  const publisherFeeRate = readNumber('#calcPublisherFee', 10) / 100;
  const result = calculateFeesLocally(sell, steamFeeRate, publisherFeeRate);
  const profitValue = result.sellerReceives - buy;
  const roiValue = buy > 0 ? profitValue / buy : 0;

  $('#calcReceive').textContent = euro.format(result.sellerReceives);
  $('#calcFees').textContent = euro.format(result.fees);
  $('#calcProfit').textContent = euro.format(profitValue);
  $('#calcRoi').textContent = percent.format(roiValue);
  $('#calcProfit').style.color = profitValue >= 0 ? 'var(--good)' : 'var(--bad)';
  $('#calcRoi').style.color = roiValue >= 0 ? 'var(--good)' : 'var(--bad)';
}

function addManualTrade() {
  const name = $('#calcName').value.trim() || 'Manual card';
  const buyPrice = readNumber('#calcBuy');
  const targetSellPrice = readNumber('#calcSell');
  trades.unshift({
    id: crypto.randomUUID(),
    name,
    marketUrl: '',
    status: 'ordered',
    quantity: 1,
    buyPrice,
    targetSellPrice,
    actualSellPrice: null,
    steamFeeRate: readNumber('#calcSteamFee', 5) / 100,
    publisherFeeRate: readNumber('#calcPublisherFee', 10) / 100,
    createdAt: new Date().toISOString()
  });
  saveTrades();
  activateTab('tracker');
}

function expectedProfitForTrade(trade) {
  const fee = calculateFeesLocally(trade.targetSellPrice, trade.steamFeeRate, trade.publisherFeeRate);
  return (fee.sellerReceives - trade.buyPrice) * trade.quantity;
}

function realisedProfitForTrade(trade) {
  if (trade.status !== 'sold' || !(trade.actualSellPrice >= 0)) return 0;
  const fee = calculateFeesLocally(trade.actualSellPrice, trade.steamFeeRate, trade.publisherFeeRate);
  return (fee.sellerReceives - trade.buyPrice) * trade.quantity;
}

function renderTracker() {
  const body = $('#trackerBody');
  body.innerHTML = '';

  if (!trades.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="9">No trades tracked yet.</td></tr>';
  } else {
    trades.forEach(trade => {
      const row = document.createElement('tr');
      const nameCell = document.createElement('td');
      if (trade.marketUrl) {
        const link = document.createElement('a');
        link.className = 'item-link';
        link.href = trade.marketUrl;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = trade.name;
        nameCell.appendChild(link);
      } else {
        nameCell.textContent = trade.name;
      }

      const statusCell = document.createElement('td');
      const status = document.createElement('select');
      status.className = 'status-select';
      [['ordered', 'Buy order'], ['bought', 'Bought'], ['listed', 'Listed'], ['sold', 'Sold']].forEach(([value, label]) => {
        const option = new Option(label, value, false, trade.status === value);
        status.add(option);
      });
      status.addEventListener('change', () => {
        trade.status = status.value;
        saveTrades();
      });
      statusCell.appendChild(status);

      const qtyCell = document.createElement('td');
      const qty = document.createElement('input');
      qty.className = 'qty-input';
      qty.type = 'number';
      qty.min = '1';
      qty.step = '1';
      qty.value = String(trade.quantity);
      qty.addEventListener('change', () => {
        trade.quantity = Math.max(1, Math.round(Number(qty.value) || 1));
        saveTrades();
      });
      qtyCell.appendChild(qty);

      const actualCell = document.createElement('td');
      const actual = document.createElement('input');
      actual.className = 'actual-sell-input';
      actual.type = 'number';
      actual.min = '0';
      actual.step = '0.01';
      actual.placeholder = '€';
      actual.value = trade.actualSellPrice == null ? '' : String(trade.actualSellPrice);
      actual.addEventListener('change', () => {
        const value = Number(actual.value);
        trade.actualSellPrice = Number.isFinite(value) ? value : null;
        saveTrades();
      });
      actualCell.appendChild(actual);

      const deleteCell = document.createElement('td');
      const deleteButton = document.createElement('button');
      deleteButton.className = 'small';
      deleteButton.textContent = 'Remove';
      deleteButton.addEventListener('click', () => {
        trades = trades.filter(entry => entry.id !== trade.id);
        saveTrades();
      });
      deleteCell.appendChild(deleteButton);

      const realised = realisedProfitForTrade(trade);
      const cells = [
        nameCell,
        statusCell,
        qtyCell,
        textCell(euro.format(trade.buyPrice)),
        textCell(euro.format(trade.targetSellPrice)),
        textCell(euro.format(expectedProfitForTrade(trade)), 'profit good'),
        actualCell,
        textCell(euro.format(realised), `profit ${realised >= 0 ? 'good' : 'bad'}`),
        deleteCell
      ];
      cells.forEach(cell => row.appendChild(cell));
      body.appendChild(row);
    });
  }

  const committed = trades
    .filter(trade => trade.status !== 'sold')
    .reduce((sum, trade) => sum + trade.buyPrice * trade.quantity, 0);
  const expected = trades
    .filter(trade => trade.status !== 'sold')
    .reduce((sum, trade) => sum + expectedProfitForTrade(trade), 0);
  const realised = trades.reduce((sum, trade) => sum + realisedProfitForTrade(trade), 0);
  const active = trades.filter(trade => trade.status !== 'sold').length;

  $('#summaryCommitted').textContent = euro.format(committed);
  $('#summaryExpected').textContent = euro.format(expected);
  $('#summaryRealised').textContent = euro.format(realised);
  $('#summaryActive').textContent = String(active);
  $('#tradeCount').textContent = String(trades.length);
}

function textCell(text, className = '') {
  const cell = document.createElement('td');
  cell.textContent = text;
  cell.className = className;
  return cell;
}

function exportCsv() {
  if (!trades.length) return;
  const headers = ['Card', 'Status', 'Quantity', 'Buy price', 'Target sell', 'Actual sell', 'Expected profit', 'Realised profit', 'Created'];
  const rows = trades.map(trade => [
    trade.name,
    trade.status,
    trade.quantity,
    trade.buyPrice.toFixed(2),
    trade.targetSellPrice.toFixed(2),
    trade.actualSellPrice == null ? '' : trade.actualSellPrice.toFixed(2),
    expectedProfitForTrade(trade).toFixed(2),
    realisedProfitForTrade(trade).toFixed(2),
    trade.createdAt
  ]);
  const csv = [headers, ...rows]
    .map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `steam-flip-trades-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function initialise() {
  const savedBalance = localStorage.getItem(balanceKey);
  if (savedBalance !== null) $('#walletBalance').value = savedBalance;
  $('#walletBalance').addEventListener('change', () => localStorage.setItem(balanceKey, $('#walletBalance').value));

  $$('.tab').forEach(button => button.addEventListener('click', () => activateTab(button.dataset.tab)));
  $('#scanButton').addEventListener('click', scanCards);
  ['calcBuy', 'calcSell', 'calcSteamFee', 'calcPublisherFee'].forEach(id => $(`#${id}`).addEventListener('input', updateCalculator));
  $('#addManualTrade').addEventListener('click', addManualTrade);
  $('#exportButton').addEventListener('click', exportCsv);
  $('#clearButton').addEventListener('click', () => {
    if (confirm('Delete all locally stored trades?')) {
      trades = [];
      saveTrades();
    }
  });

  hideStatus();
  updateCalculator();
  renderRecommendations();
  renderTracker();
}

document.addEventListener('DOMContentLoaded', initialise);
