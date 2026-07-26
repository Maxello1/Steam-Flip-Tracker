'use strict';

let lastSent = null;

function parseBalance(text) {
  if (typeof text !== 'string') return null;
  let cleaned = text.trim().replace(/[^0-9,.-]/g, '');
  if (!cleaned) return null;
  const comma = cleaned.lastIndexOf(',');
  const dot = cleaned.lastIndexOf('.');
  if (comma > dot) cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  else cleaned = cleaned.replace(/,/g, '');
  const value = Number(cleaned);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function findWalletText() {
  const selectors = [
    '#header_wallet_balance',
    '.global_action_link[href*="account/history"]',
    'a[href*="account/history"]'
  ];
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element?.textContent && parseBalance(element.textContent) !== null) return element.textContent;
  }
  return null;
}

function syncWallet() {
  const balance = parseBalance(findWalletText());
  if (balance === null || balance === lastSent) return;
  lastSent = balance;
  chrome.runtime.sendMessage({ type: 'wallet-balance', balance, currency: 'EUR' });
}

syncWallet();
setInterval(syncWallet, 30000);
new MutationObserver(syncWallet).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
