'use strict';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'wallet-balance') return false;

  fetch('http://127.0.0.1:3210/api/wallet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      balance: message.balance,
      currency: message.currency || 'EUR',
      source: 'steam-market-extension'
    })
  })
    .then(response => sendResponse({ ok: response.ok }))
    .catch(error => sendResponse({ ok: false, error: error.message }));

  return true;
});
