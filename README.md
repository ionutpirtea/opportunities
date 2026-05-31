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
- `GET /alerts-management` - Manage Telegram recipients (add/remove/enable/disable), send a test alert, and edit thresholds for 52W, 1D, and 2D rules
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

The app can also send Telegram messages for stocks that meet the same rules used on the Alerts page (52-week gap, 1D/2D drop gate, market cap gate, and cash-flow exclusion).

## WhatsApp Alerts (Twilio)
WhatsApp support is kept for compatibility, but automated alert broadcasting now uses Telegram.

1. Create a Twilio account and enable WhatsApp Sandbox (or approved WhatsApp sender).
2. Copy `.env.example` to `.env` and set:
	- `WHATSAPP_ALERTS_ENABLED=true`
	- `TWILIO_ACCOUNT_SID`
	- `TWILIO_AUTH_TOKEN`
	- `TWILIO_WHATSAPP_FROM` (example: `whatsapp:+14155238886`)
	- `TWILIO_WHATSAPP_TO` (optional fallback recipient if none are configured in UI)
3. Restart the app.

Recipients:
- Use `GET /alerts-management` to add/remove Telegram recipients and enable/disable each recipient.
- Only enabled recipients receive Telegram alerts.

Safety control:
- `WHATSAPP_DIGEST_MODE=single` sends one digest message per run (recommended).
- Set `WHATSAPP_DIGEST_MODE=multiple` to send one message per alert.
- `WHATSAPP_MAX_MESSAGES_PER_RUN` is used in `multiple` mode.

Thresholds:
- `ALERT_THRESHOLD_PCT` controls single-check move alerts.
- `ALERT_2DAY_THRESHOLD_PCT` controls 2-business-day move alerts.
- You can change both live from the report page using the threshold form (runtime only; resets after app restart unless you also update `.env`).

Delivery status appears in `/health` under `lastRun.whatsapp`.

## Telegram Alerts
The app can send Telegram alerts for stocks that meet the Alerts page criteria.

Each Telegram alert message includes:
- Ticker
- Company description
- Current price
- Check execution time

1. Create a Telegram bot with BotFather and copy the bot token.
2. Get your target `chat_id` (user, group, or channel).
3. Set these environment variables in `.env`:
	- `TELEGRAM_ALERTS_ENABLED=true`
	- `TELEGRAM_BOT_TOKEN`
	- `TELEGRAM_CHAT_ID` (optional fallback recipient when no managed recipients are enabled)
	- `TELEGRAM_MAX_MESSAGES_PER_RUN` (optional safety cap)
4. Restart the app.

Recipient management and testing:
- Use `GET /alerts-management` to add recipients (`chat_id` or `@username`) and toggle enable/disable.
- Use the "Test Telegram Alert" button on Alerts Management page, or call `POST /telegram/test`.

Delivery status appears in `/health` under `lastRun.telegram`.

## VM Startup Script (Node + Nginx)
For VM restarts or quick recoveries, use the included Linux script to start the app stack in order (Node first, then Nginx reload).

On the VM:
```bash
cd ~/opportunities
chmod +x scripts/start_stack.sh
./scripts/start_stack.sh
```

What it does:
- Installs dependencies if `node_modules` is missing
- Stops old app process on port `3000`
- Starts `node app.js` in background and waits for `/health`
- Starts + reloads Nginx

Optional custom app port:
```bash
APP_PORT=3000 ./scripts/start_stack.sh
```
