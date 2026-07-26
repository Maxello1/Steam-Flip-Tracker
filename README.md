# Steam Flip Tracker

A local, read-only browser app for:

- scanning public Steam Community Market trading-card data;
- recommending possible buy-order and sell-listing prices;
- estimating Steam and game-specific fees;
- ranking cards using profit, ROI, volume and order-book depth;
- tracking manual purchases, listings and completed sales;
- exporting the tracker as CSV;
- optionally syncing the wallet balance shown in a logged-in Steam Market tab.

It does **not** place orders, cancel orders, list items or confirm transactions.

## Windows setup

1. Install Node.js 18 or newer.
2. Clone or download this repository.
3. Double-click `start.bat`.
4. Open `http://127.0.0.1:3210` if it does not open automatically.
5. Leave the command window open while using the app.

## Optional automatic wallet sync

The `extension` folder contains an unpacked Chrome/Edge extension. It reads only the wallet balance displayed in an already logged-in Steam Market page and sends the number to the local tracker.

1. Start the tracker.
2. Open your browser's extension manager.
3. Enable Developer mode.
4. Choose **Load unpacked** and select the repository's `extension` folder.
5. Open or refresh `https://steamcommunity.com/market/`.

No Steam password, cookie, Steam Guard code or API key is stored by the tracker.

## Other systems

Run:

```bash
node server.js
```

Then open `http://127.0.0.1:3210`.

## Scanner changes in 1.1

The scanner now:

- combines popular-card and price-ascending discovery pools;
- interleaves and deduplicates those pools;
- reuses market snapshots for ten minutes;
- checks spread, fees, wallet affordability and ROI before requesting volume;
- reports rejection counts, near misses and exact request failures;
- uses order graphs for best-price depth instead of treating rendered HTML tables as JSON arrays;
- shows how many copies the current wallet can theoretically afford.

The default filters are intentionally loose enough to verify that the scanner works: one cent minimum profit, ten percent ROI and no minimum volume. Tighten them after a successful test scan.

## How recommendations work

For each candidate, the scanner attempts to read:

- the current highest buy order;
- the current lowest sell listing;
- approximate order-book depth at those prices;
- recent reported market volume;
- the estimated amount a seller receives after fees.

The default suggestion is:

- **Buy:** one cent above the current highest buy order;
- **Sell:** one cent below the current lowest listing;
- show only cards meeting the configured profit, ROI, volume, wallet and maximum-price filters.

Always open the Steam listing and verify live prices before acting.

## Rate limits and failed scans

Steam can rate-limit public market requests. The app scans sequentially and caches item IDs and recent snapshots.

If a scan fails:

- open **Scan diagnostics** to see exact errors;
- do not repeatedly hammer the Scan button;
- wait before retrying;
- increase **Delay per item**;
- reduce **Search pages per pool** or **Maximum item lookups**;
- use the manual calculator while the scanner is unavailable.

## Data storage

Trades remain in browser local storage. Wallet sync state and temporary market snapshots are stored in the local `data` directory and ignored by Git.

Use **Export CSV** before clearing browser data or moving to another computer.

## Fee settings

Defaults are 5% Steam fee and 10% game-specific fee. Steam applies minimum fee amounts on low-priced items, so calculations work in cents instead of only multiplying the visible sale price by 85%.

## Important limitation

The scanner relies on public Steam Community Market webpage endpoints rather than a documented consumer trading API. Steam can change those pages or responses at any time, which may require updating the app.
