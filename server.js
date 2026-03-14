import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const API_KEY = process.env.ODDS_API_KEY;
const PORT = process.env.PORT || 3000;
const REFRESH_MS = parseInt(process.env.REFRESH_INTERVAL_MS) || 30000;
const MIN_PROFIT = parseFloat(process.env.MIN_PROFIT_THRESHOLD) || 0.5;

// ─────────────────────────────────────────────
// Sports to scan — all active non-outright sports
// We fetch these dynamically on startup
// ─────────────────────────────────────────────
// Only scan the highest-value sports to preserve API quota
// Each sport = 1 API request. At 500 req/month, scan ~10 sports every 10 minutes = ~2160 req/month
const PRIORITY_SPORTS = [
  'basketball_nba',
  'basketball_ncaab',
  'baseball_mlb',
  'baseball_mlb_preseason',
  'icehockey_nhl',
  'soccer_epl',
  'soccer_spain_la_liga',
  'soccer_germany_bundesliga',
  'mma_mixed_martial_arts',
  'aussierules_afl',
  'cricket_ipl',
  'rugbyleague_nrl',
];

// ─────────────────────────────────────────────
// State
// ─────────────────────────────────────────────
let cachedOpportunities = [];
let lastFetch = null;
let apiUsage = { remaining: null, used: null, last: null };
let isRefreshing = false;

// ─────────────────────────────────────────────
// Core arbitrage detection
// For a 2-way market: arb exists if 1/odds1 + 1/odds2 < 1
// For a 3-way market: arb exists if 1/o1 + 1/o2 + 1/o3 < 1
// ─────────────────────────────────────────────
function detectArbitrage(game) {
  const opportunities = [];
  const { id, sport_key, sport_title, home_team, away_team, commence_time, bookmakers } = game;

  if (!bookmakers || bookmakers.length < 2) return opportunities;

  // Collect best odds per outcome across all bookmakers (back bets only, skip h2h_lay)
  const outcomeMap = {}; // outcome name -> { bestOdds, bookmaker, bookmakerKey }

  for (const bm of bookmakers) {
    for (const market of bm.markets) {
      if (market.key !== 'h2h') continue; // focus on moneyline for MVP
      for (const outcome of market.outcomes) {
        const name = outcome.name;
        if (!outcomeMap[name] || outcome.price > outcomeMap[name].bestOdds) {
          outcomeMap[name] = {
            bestOdds: outcome.price,
            bookmaker: bm.title,
            bookmakerKey: bm.key,
            lastUpdate: market.last_update,
          };
        }
      }
    }
  }

  const outcomes = Object.entries(outcomeMap); // [ [name, {bestOdds, bookmaker}] ]
  if (outcomes.length < 2) return opportunities;

  // Calculate implied probability sum
  const impliedSum = outcomes.reduce((sum, [, data]) => sum + (1 / data.bestOdds), 0);
  const profitPct = ((1 - impliedSum) / impliedSum) * 100;

  if (profitPct < MIN_PROFIT) return opportunities;

  // Build the opportunity object
  const totalImplied = impliedSum;
  const bets = outcomes.map(([name, data]) => {
    const impliedProb = 1 / data.bestOdds;
    const stakeShare = impliedProb / totalImplied; // proportion of total stake
    return {
      outcome: name,
      bookmaker: data.bookmaker,
      bookmakerKey: data.bookmakerKey,
      odds: data.bestOdds,
      stakeShare: parseFloat(stakeShare.toFixed(6)),
      lastUpdate: data.lastUpdate,
    };
  });

  opportunities.push({
    id: `${id}_h2h`,
    gameId: id,
    sport: sport_key,
    sportTitle: sport_title,
    match: `${away_team} vs ${home_team}`,
    homeTeam: home_team,
    awayTeam: away_team,
    commence_time,
    market: 'Moneyline (H2H)',
    profit: parseFloat(profitPct.toFixed(3)),
    impliedSum: parseFloat(impliedSum.toFixed(6)),
    bets,
    detectedAt: new Date().toISOString(),
  });

  return opportunities;
}

// ─────────────────────────────────────────────
// Fetch odds for one sport key
// ─────────────────────────────────────────────
async function fetchSportOdds(sportKey) {
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${API_KEY}&regions=us,uk,eu,au&markets=h2h&oddsFormat=decimal`;

  const res = await fetch(url);

  // Track API usage from headers
  const remaining = res.headers.get('x-requests-remaining');
  const used = res.headers.get('x-requests-used');
  if (remaining !== null) {
    apiUsage.remaining = parseInt(remaining);
    apiUsage.used = parseInt(used);
    apiUsage.last = new Date().toISOString();
  }

  if (res.status === 422) return []; // sport has no current events
  if (res.status === 401) throw new Error('Invalid API key');
  if (res.status === 429) throw new Error('Rate limit hit');
  if (!res.ok) throw new Error(`API error ${res.status} for ${sportKey}`);

  return res.json();
}

// ─────────────────────────────────────────────
// Main refresh loop
// Fetches sports with events, scans for arbs
// ─────────────────────────────────────────────
async function refreshOpportunities() {
  if (isRefreshing) return;
  isRefreshing = true;

  console.log(`[${new Date().toISOString()}] Refreshing odds...`);

  try {
    // First get list of active sports to know what has live events
    const sportsRes = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${API_KEY}`);
    const allSports = await sportsRes.json();

    // Filter to active non-outright sports that are in our priority list
    const activeSports = allSports
      .filter(s => s.active && !s.has_outrights && PRIORITY_SPORTS.includes(s.key))
      .map(s => s.key);

    // Only scan priority sports — do NOT scan all sports, it burns quota
    const sportsToCheck = activeSports;
    console.log(`Checking ${sportsToCheck.length} sports for arbitrage...`);

    const allOpportunities = [];

    // Fetch sports sequentially to respect rate limits
    // Each call costs 1 request per ~100 events
    for (const sportKey of sportsToCheck) {
      // Stop if we're running low on quota
      if (apiUsage.remaining !== null && apiUsage.remaining < 5) {
        console.warn('Low API quota — pausing fetches');
        break;
      }

      try {
        const games = await fetchSportOdds(sportKey);
        for (const game of games) {
          const opps = detectArbitrage(game);
          allOpportunities.push(...opps);
        }
        // Small delay between requests to be polite
        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        console.error(`Error fetching ${sportKey}:`, err.message);
      }
    }

    // Sort by profit descending
    allOpportunities.sort((a, b) => b.profit - a.profit);

    cachedOpportunities = allOpportunities;
    lastFetch = new Date().toISOString();

    console.log(`Found ${allOpportunities.length} arbitrage opportunities. API remaining: ${apiUsage.remaining}`);

    // Broadcast to all connected WebSocket clients
    broadcast({ type: 'opportunities', data: allOpportunities, lastFetch, apiUsage });

  } catch (err) {
    console.error('Refresh error:', err.message);
    broadcast({ type: 'error', message: err.message });
  } finally {
    isRefreshing = false;
  }
}

// ─────────────────────────────────────────────
// WebSocket broadcast
// ─────────────────────────────────────────────
function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) { // OPEN
      client.send(msg);
    }
  }
}

wss.on('connection', (ws) => {
  console.log('Client connected via WebSocket');
  // Send current data immediately on connect
  ws.send(JSON.stringify({
    type: 'opportunities',
    data: cachedOpportunities,
    lastFetch,
    apiUsage,
  }));
});

// ─────────────────────────────────────────────
// REST endpoints
// ─────────────────────────────────────────────

// Get current opportunities
app.get('/api/arbitrage', (req, res) => {
  res.json({
    opportunities: cachedOpportunities,
    count: cachedOpportunities.length,
    lastFetch,
    apiUsage,
  });
});

// Calculate stakes for a given total stake amount
app.post('/api/calculate', (req, res) => {
  const { bets, totalStake } = req.body;
  if (!bets || !totalStake) return res.status(400).json({ error: 'Missing bets or totalStake' });

  const impliedSum = bets.reduce((sum, b) => sum + (1 / b.odds), 0);
  const calculated = bets.map(b => {
    const impliedProb = 1 / b.odds;
    const stake = parseFloat(((impliedProb / impliedSum) * totalStake).toFixed(2));
    const payout = parseFloat((stake * b.odds).toFixed(2));
    return { ...b, stake, payout };
  });

  const totalInvested = calculated.reduce((s, b) => s + b.stake, 0);
  const guaranteedReturn = calculated[0]?.payout || 0;
  const profit = parseFloat((guaranteedReturn - totalInvested).toFixed(2));
  const profitPct = parseFloat(((profit / totalInvested) * 100).toFixed(3));

  res.json({ bets: calculated, totalInvested, guaranteedReturn, profit, profitPct });
});

// Status endpoint
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    lastFetch,
    apiUsage,
    opportunityCount: cachedOpportunities.length,
    refreshInterval: REFRESH_MS,
  });
});

// Force immediate refresh (for manual trigger)
app.post('/api/refresh', async (req, res) => {
  res.json({ message: 'Refresh triggered' });
  await refreshOpportunities();
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🦞 EdgeIQ Arbitrage Server running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket ready`);
  console.log(`🔑 API Key: ${API_KEY ? '***' + API_KEY.slice(-4) : 'MISSING'}`);
  console.log(`⏱  Refresh every ${REFRESH_MS / 1000}s\n`);

  // Initial fetch immediately
  refreshOpportunities();

  // Then on interval
  setInterval(refreshOpportunities, REFRESH_MS);
});
