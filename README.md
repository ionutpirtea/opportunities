# Ticker Price Monitor

A Node.js web app that:
- Loads ticker symbols from `tickers.csv`
- Fetches latest prices from Yahoo Finance
- Stores every check in `data/price_history.csv` with timestamp
- Runs checks on a schedule
- Creates alerts in `data/alerts.csv` when price moves exceed a threshold
- Shows a report page with latest prices and recent alerts
- Includes a Biggest Movers page based on history window

## Requirements
- Node.js 18+

## Setup
```bash
npm install
copy .env.example .env
npm start
```

On Linux/macOS/Termux:
```bash
cp .env.example .env
npm start
```

Open: `http://localhost:3000/report`

## Ticker Source
Tickers are read from `tickers.csv`. The parser accepts commas/newlines and ignores empty values.

## API/Pages
- `GET /report` - HTML report with latest prices and recent alerts
	- Add `?refreshRefs=1` to force-refresh historical reference prices
- `GET /index-charts` - YTD chart page for S&P 500, FTSE 100, DAX, EURO STOXX 50, CAC 40, and Nikkei 225
- `POST /config/thresholds` - Update runtime alert thresholds from UI (`thresholdPct`, `threshold2DayPct`)
- `GET /movers` - HTML page for biggest movers over a selectable time window
- `POST /run-check` - Trigger manual check immediately
- `GET /alerts` - Recent alerts JSON
- `GET /health` - Health status JSON

## Notes on Alerts
Current alerts are saved in CSV and shown in the report. Good notification channels to add next:
- Telegram bot messages
- Email (SMTP)
- Discord webhook
- Push notifications (Pushover or Firebase Cloud Messaging)

## WhatsApp Alerts (Twilio)
The app can send WhatsApp alerts for price moves that pass `ALERT_THRESHOLD_PCT`.

1. Create a Twilio account and enable WhatsApp Sandbox (or approved WhatsApp sender).
2. Copy `.env.example` to `.env` and set:
	- `WHATSAPP_ALERTS_ENABLED=true`
	- `TWILIO_ACCOUNT_SID`
	- `TWILIO_AUTH_TOKEN`
	- `TWILIO_WHATSAPP_FROM` (example: `whatsapp:+14155238886`)
	- `TWILIO_WHATSAPP_TO` (example: `whatsapp:+407XXXXXXXX`)
3. Restart the app.

Safety control:
- `WHATSAPP_DIGEST_MODE=single` sends one digest message per run (recommended).
- Set `WHATSAPP_DIGEST_MODE=multiple` to send one message per alert.
- `WHATSAPP_MAX_MESSAGES_PER_RUN` is used in `multiple` mode.

Thresholds:
- `ALERT_THRESHOLD_PCT` controls single-check move alerts.
- `ALERT_2DAY_THRESHOLD_PCT` controls 2-business-day move alerts.
- You can change both live from the report page using the threshold form (runtime only; resets after app restart unless you also update `.env`).

Delivery status appears in `/health` under `lastRun.whatsapp`.
