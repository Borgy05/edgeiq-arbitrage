@echo off
echo Creating .env file...
(
echo ODDS_API_KEY=6feecdd7f26d8ff88e9c6451f4e85cc1
echo PORT=3000
echo REFRESH_INTERVAL_MS=600000
echo MIN_PROFIT_THRESHOLD=0.5
) > .env
echo .env created successfully!
echo.
echo Installing dependencies...
npm install
echo.
echo Starting EdgeIQ server...
echo Open http://localhost:3000/real-time-arbitrage.htm in your browser
echo.
node server.js
