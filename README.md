# BTC Quant Cloud

Public cloud state for the BTC Quant Lab paper-trading dashboard.

- GitHub Actions runs at five minutes after every 4-hour BTC candle close.
- Market data comes from Binance's public BTCUSDT 4H endpoint.
- The strategy is fixed at `trend-breakout-v0.3`.
- `state/paper.json` contains only simulated account state.

This repository does not contain exchange credentials and cannot place real orders. It is for research and paper trading only, not investment advice.
