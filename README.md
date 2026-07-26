# Steam Flip Tracker

A local, read-only browser app for:

- scanning public Steam Community Market trading-card data;
- recommending possible buy-order and sell-listing prices;
- estimating Steam and game-specific fees;
- ranking cards using profit, ROI, volume and order-book queue size;
- tracking manual purchases, listings and completed sales;
- exporting the tracker as CSV.

It does **not** log in to Steam, use account cookies, place orders, cancel orders, list items or confirm transactions.

## Windows setup

1. Install Node.js 18 or newer from the official Node.js website.
2. Extract this folder.
3. Double-click `start.bat`.
4. Open `http://127.0.0.1:3210` if it does not open automatically.
5. Leave the command window open while using the app.

## Other systems

Run:

```bash
node server.js
```

Then open `http://127.0.0.1:3210`.

## How recommendations work

For each public card result, the scanner attempts to read:

- the current highest buy order;
- the current lowest sell listing;
- quantities at the best buy and sell prices;
- recent reported market volume;
- the estimated amount a seller receives after fees.

The default suggestion is:

- **Buy:** one cent above the current highest buy order;
- **Sell:** one cent below the current lowest listing;
- show only cards meeting your minimum profit, ROI, volume and maximum buy-price settings.

Always open the Steam listing and verify the live prices before acting. Markets can change between the scan and your manual order.

## Rate limits and failed scans

Steam can rate-limit public market requests. The app deliberately scans sequentially and caches item IDs in `data/item-name-cache.json`.

If a scan fails:

- do not repeatedly hammer the Scan button;
- wait before retrying;
- increase **Delay per item**;
- reduce **Search pages** and **Maximum results**;
- use the manual calculator while the scanner is unavailable.

## Data storage

Trade data and wallet balance are stored in your browser's local storage. Use **Export CSV** before clearing browser data or moving to another computer.

## Fee settings

Defaults are 5% Steam fee and 10% game-specific fee. Steam applies minimum fee amounts on low-priced items, so the calculator works in cents rather than simply multiplying the visible sale price by 85%.

## Important limitation

The scanner relies on public Steam Community Market webpage endpoints rather than a documented consumer trading API. Steam can change those pages or responses at any time, which may require updating the app.
