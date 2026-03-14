# EdgeIQ Arbitrage Finder

Real-time sports arbitrage detector using [The Odds API](https://the-odds-api.com).

## Setup

```bash
npm install
node server.js
```

Then open `real-time-arbitrage.htm` in your browser.

## Config

Create a `.env` file:
```
ODDS_API_KEY=your_key_here
PORT=3000
REFRESH_INTERVAL_MS=30000
MIN_PROFIT_THRESHOLD=0.5
```

## Features
- Live arbitrage detection across 40+ sports and 30+ bookmakers
- WebSocket real-time updates every 30 seconds
- Automatic stake calculator
- Filter by sport, minimum profit, search
- Direct links to bookmakers

