# Udgata-Algo

A beginner-friendly Indian market dashboard for learning about stocks, options, indicators, and machine-learning signals. It uses Upstox market data and simulated paper orders. It does **not** send orders to a broker.

## Features

- NSE quote snapshots refreshed about once a minute while the dashboard is open.
- Daily and current-session one-minute stock charts.
- Option chains for NIFTY, BANKNIFTY, FINNIFTY, and the four stocks in the watchlist.
- RSI, MACD, 20- and 50-day averages, Bollinger Bands, and volume comparisons.
- Three small classifiers: logistic regression, random forest, and gradient boosting.
- A chatbot with a built-in no-key helper and optional OpenAI API replies.
- A local virtual portfolio for paper stock and option orders.

The current watchlist is TCS, INFY, RELIANCE, and HDFCBANK. The model uses historical **daily** candles and runs when you select “Train and compare.” It does not retrain every minute. Quotes update paper position values; the chart can show one-minute candles. Past model accuracy does not predict future results.

## Data and keys

The app uses an Upstox Analytics Token for market quotes, historical candles, and option chains. The token is read-only: it cannot place real orders. The token and optional chatbot key are read only by the local server and should never be added to frontend code or committed to GitHub.

Create a free Upstox Analytics Token from **Developer Apps → Analytics**. If **server/.env** does not exist yet, create it from the example:

macOS/Linux:

~~~sh
cp server/.env.example server/.env
~~~

Windows PowerShell:

~~~powershell
Copy-Item server/.env.example server/.env
~~~

If **server/.env** already exists, keep it and add or update these lines. Edit the file and set:

~~~dotenv
UPSTOX_ANALYTICS_TOKEN=your_upstox_token
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5-mini
~~~

**OPENAI_API_KEY** is optional. If it is blank, the dashboard uses a small built-in helper. OpenAI API calls may require paid API credits. Keep **server/.env** private.

## Install and run

Install Node.js and Python 3 first. Then install the Python dependencies from the project folder:

macOS/Linux:

~~~sh
python3 -m venv venv
source venv/bin/activate
python -m pip install -r python/requirements.txt
~~~

Windows PowerShell:

~~~powershell
py -m venv venv
.\venv\Scripts\Activate.ps1
python -m pip install -r python/requirements.txt
~~~

In one terminal, start the server:

~~~sh
cd server
npm install
npm start
~~~

In a second terminal, start the web app:

~~~sh
cd client
npm install
npm run dev
~~~

Open <http://localhost:5173>.

After changing **server/.env**, restart the server so it reads the new values.

## Project layout

~~~text
client/       React dashboard and plain CSS
server/       Express API, Upstox connection, and paper portfolio
python/       Indicators and machine-learning models
~~~

## Important limits

- Market snapshots are polled once a minute; they are not second-by-second streaming.
- One-minute candles show the current session and may not be available outside market hours.
- The models use daily candles and are educational examples, not investment advice.
- Paper orders do not include brokerage, taxes, slippage, liquidity, or option assignment.
- Chatbot answers can be wrong. Do not treat them or model signals as instructions to trade.
- The local paper portfolio is stored in **server/portfolio.json**, which is intentionally ignored by Git.

## Before publishing

Make sure **server/.env** is not selected for upload and never paste credentials into issues or screenshots. This project does not include a license; choose one if you want to grant other people permission to reuse your code.
