# Balance-sync extension

This unpacked Chrome/Edge extension reads the wallet balance already displayed in an open, logged-in Steam Community Market tab. It sends only the numeric balance to `http://127.0.0.1:3210/api/wallet`.

It does not read or store your password, Steam Guard codes, session cookies or API keys, and it does not place or alter market orders.

## Install in Chrome or Edge

1. Start Steam Flip Tracker with `start.bat`.
2. Open the browser extension manager.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select this `extension` folder.
6. Open or refresh `https://steamcommunity.com/market/` while logged in.

The tracker polls the local server every five seconds and shows the last sync source and time below the balance.
