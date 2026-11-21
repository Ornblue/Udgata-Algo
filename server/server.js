// Upstox is used for read-only market data. Every order in this app is simulated.
const express = require("express");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const app = express();
app.use(express.json());

// Keep local secrets in server/.env without adding a dependency.
if (fs.existsSync(path.join(__dirname, ".env"))) {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

const WATCHLIST = [
  { symbol: "TCS", name: "Tata Consultancy Services", instrument: "NSE_EQ|INE467B01029" },
  { symbol: "INFY", name: "Infosys", instrument: "NSE_EQ|INE009A01021" },
  { symbol: "RELIANCE", name: "Reliance Industries", instrument: "NSE_EQ|INE002A01018" },
  { symbol: "HDFCBANK", name: "HDFC Bank", instrument: "NSE_EQ|INE040A01034" },
];
const UNDERLYINGS = {
  NIFTY: { name: "NIFTY 50", instrument: "NSE_INDEX|Nifty 50" },
  BANKNIFTY: { name: "NIFTY BANK", instrument: "NSE_INDEX|Nifty Bank" },
  FINNIFTY: { name: "NIFTY FIN SERVICE", instrument: "NSE_INDEX|Nifty Fin Service" },
  ...Object.fromEntries(WATCHLIST.map(({ symbol, name, instrument }) => [symbol, { name, instrument }])),
};
const START_CASH = 100000;
const MAX_ORDER_PERCENT = 10;
const MIN_CONFIDENCE = 0.5;
const PORTFOLIO_FILE = path.join(__dirname, "portfolio.json");
const PYTHON_FILE = path.join(__dirname, "..", "python", "agent.py");
const VENV_PYTHON = process.platform === "win32"
  ? path.join(__dirname, "..", "venv", "Scripts", "python.exe")
  : path.join(__dirname, "..", "venv", "bin", "python");
const PYTHON = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : (process.platform === "win32" ? "python" : "python3");
let latestPrices = {};
const UPSTOX_API = "https://api.upstox.com/v2";
const OPTIONS_UNAVAILABLE = "Add your free Upstox Analytics Token to server/.env to load live prices.";
const latestOptionQuotes = new Map();
const optionContracts = new Map();
function upstoxToken() {
  const token = process.env.UPSTOX_ANALYTICS_TOKEN?.trim();
  return token && token !== "put_your_token_here" ? token : "";
}

async function upstox(pathname, params = {}) {
  const token = upstoxToken();
  if (!token) throw new Error(OPTIONS_UNAVAILABLE);
  const url = new URL(pathname, UPSTOX_API);
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
  const body = await response.json();
  if (!response.ok || body.status !== "success") throw new Error(body.errors?.[0]?.message || `Upstox returned HTTP ${response.status}. Check your Analytics Token.`);
  return body.data;
}

function loadPortfolio() {
  if (!fs.existsSync(PORTFOLIO_FILE)) return emptyPortfolio();
  const saved = JSON.parse(fs.readFileSync(PORTFOLIO_FILE, "utf8"));
  return { ...emptyPortfolio(), ...saved, holdings: saved.holdings || {}, orders: saved.orders || [], optionHoldings: saved.optionHoldings || {}, optionOrders: saved.optionOrders || [] };
}

function emptyPortfolio() {
  return { cash: START_CASH, holdings: {}, orders: [], optionHoldings: {}, optionOrders: [], maxOrderPercent: MAX_ORDER_PERCENT };
}

function savePortfolio(portfolio) {
  fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(portfolio, null, 2));
}

function totalValue(portfolio) {
  const stocks = Object.values(portfolio.holdings).reduce((sum, stock) => sum + stock.qty * stock.price, 0);
  const options = Object.values(portfolio.optionHoldings || {}).reduce((sum, option) => sum + option.quantity * option.price, 0);
  return portfolio.cash + stocks + options;
}

function publicPortfolio(portfolio) { return { ...portfolio, total: totalValue(portfolio) }; }

function candlesFromApi(rows) {
  return rows.map(([date, open, high, low, close, volume]) => ({ date, open, high, low, close, volume })).reverse();
}

async function getDailyHistory(symbol, days = 730) {
  const instrument = WATCHLIST.find((entry) => entry.symbol === symbol)?.instrument;
  if (!instrument) throw new Error("Symbol is not in the watchlist.");
  const to = indiaDate();
  const from = indiaDate(-days);
  const data = await upstox(`/v3/historical-candle/${encodeURIComponent(instrument)}/days/1/${to}/${from}`);
  return candlesFromApi(data.candles || []);
}

function indiaDate(offsetDays = 0) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(Date.now() + offsetDays * 86400000));
}

function askPython(symbol, candles) {
  return new Promise((resolve, reject) => {
    execFile(PYTHON, [PYTHON_FILE, symbol, JSON.stringify(candles)], { timeout: 45000 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr.trim() || error.message));
      try {
        const data = JSON.parse(stdout);
        if (data.error) return reject(new Error(data.error));
        resolve(data);
      } catch { reject(new Error("Could not read model output.")); }
    });
  });
}

app.get("/api/portfolio", (req, res) => {
  try { res.json(publicPortfolio(loadPortfolio())); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.get("/api/status", (req, res) => res.json({ provider: upstoxToken() ? "Upstox · Free market data" : "Upstox setup needed", connected: Boolean(upstoxToken()), live: Boolean(upstoxToken()), optionsAvailable: Boolean(upstoxToken()), refreshSeconds: 60, tradingMode: "PAPER ONLY" }));
app.get("/api/watchlist", (req, res) => res.json({ symbols: WATCHLIST }));

app.get("/api/market/stocks", async (req, res) => {
  try {
    const quotes = await upstox("/market-quote/quotes", { instrument_key: WATCHLIST.map((entry) => entry.instrument).join(",") });
    const stocks = WATCHLIST.map((entry) => {
      const key = entry.instrument.replace("|", ":");
      const quote = quotes[key] || Object.values(quotes).find((item) => item.instrument_token === entry.instrument);
      if (!quote) throw new Error(`Upstox did not return a quote for ${entry.symbol}.`);
      const price = Number(quote.last_price);
      if (!Number.isFinite(price)) throw new Error(`No closing price is available for ${entry.symbol}.`);
      latestPrices[entry.symbol] = price;
      const previousClose = Number(quote.ohlc?.close);
      const change = Number.isFinite(Number(quote.net_change)) ? Number(quote.net_change) : null;
      return {
        symbol: entry.symbol,
        name: entry.name,
        price,
        change,
        changePercent: change != null && previousClose ? (change / previousClose) * 100 : null,
        open: quote.ohlc?.open,
        high: quote.ohlc?.high,
        low: quote.ohlc?.low,
        volume: quote.volume,
        dataDate: quote.timestamp || quote.last_trade_time,
      };
    });
    const portfolio = loadPortfolio();
    for (const stock of stocks) {
      if (portfolio.holdings[stock.symbol]) portfolio.holdings[stock.symbol].price = stock.price;
    }
    savePortfolio(portfolio);
    res.json({ provider: "Upstox · Free market data", asOf: stocks[0]?.dataDate, stocks, portfolio: publicPortfolio(portfolio) });
  } catch (error) { res.status(502).json({ error: `Market quote failed: ${error.message}` }); }
});

app.get("/api/market/history", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "TCS").toUpperCase();
    const days = Math.min(3650, Math.max(60, Number(req.query.days) || 180));
    const candles = await getDailyHistory(symbol, days);
    res.json({ symbol, interval: "1 day", candles, asOf: new Date().toISOString() });
  } catch (error) { res.status(502).json({ error: `Chart data failed: ${error.message}` }); }
});

app.get("/api/market/intraday", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "TCS").toUpperCase();
    const instrument = WATCHLIST.find((entry) => entry.symbol === symbol)?.instrument;
    if (!instrument) return res.status(400).json({ error: "Choose a symbol in the watchlist." });
    const data = await upstox(`/v3/historical-candle/intraday/${encodeURIComponent(instrument)}/minutes/1`);
    res.json({ symbol, interval: "1 minute", candles: candlesFromApi(data.candles || []), asOf: new Date().toISOString() });
  } catch (error) { res.status(502).json({ error: `Intraday chart failed: ${error.message}` }); }
});

app.get("/api/options/expiries", async (req, res) => {
  try {
    const underlying = UNDERLYINGS[req.query.underlying || "NIFTY"];
    if (!underlying) return res.status(400).json({ error: "Choose NIFTY, BANKNIFTY, or FINNIFTY." });
    const contracts = await upstox("/option/contract", { instrument_key: underlying.instrument });
    contracts.forEach((item) => optionContracts.set(item.instrument_key, item));
    res.json({ expiries: [...new Set(contracts.map((item) => item.expiry))].sort() });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.get("/api/options/chain", async (req, res) => {
  try {
    const underlying = UNDERLYINGS[req.query.underlying || "NIFTY"];
    if (!underlying) return res.status(400).json({ error: "Choose NIFTY, BANKNIFTY, or FINNIFTY." });
    const expiry = req.query.expiry;
    if (!expiry) return res.status(400).json({ error: "Choose an option expiry first." });
    const [data, contracts] = await Promise.all([
      upstox("/option/chain", { instrument_key: underlying.instrument, expiry_date: expiry }),
      upstox("/option/contract", { instrument_key: underlying.instrument, expiry_date: expiry }),
    ]);
    contracts.forEach((item) => optionContracts.set(item.instrument_key, item));
    const rows = data.map((item) => {
      const mapOption = (option, type) => {
        if (!option?.instrument_key) return null;
        const contract = optionContracts.get(option.instrument_key) || {};
        const mapped = { instrumentKey: option.instrument_key, lotSize: contract.lot_size, type, market: option.market_data, greeks: option.option_greeks };
        latestOptionQuotes.set(option.instrument_key, { ...mapped, underlying: req.query.underlying || "NIFTY", strike: item.strike_price, expiry: item.expiry });
        return mapped;
      };
      return { strike: item.strike_price, spot: item.underlying_spot_price, call: mapOption(item.call_options, "CE"), put: mapOption(item.put_options, "PE") };
    });
    const portfolio = loadPortfolio();
    for (const [key, position] of Object.entries(portfolio.optionHoldings || {})) {
      const live = latestOptionQuotes.get(key);
      if (live?.market?.ltp != null) position.price = Number(live.market.ltp);
    }
    savePortfolio(portfolio);
    res.json({ name: underlying.name, expiry, rows, portfolio: publicPortfolio(portfolio), asOf: new Date().toISOString() });
  } catch (error) { res.status(502).json({ error: `Option chain failed: ${error.message}` }); }
});

app.post("/api/run-agent", async (req, res) => {
  const portfolio = loadPortfolio();
  const results = [];
  try {
    for (const entry of WATCHLIST) {
      try {
        const rows = await getDailyHistory(entry.symbol, 730);
        if (rows.length < 60) throw new Error("Not enough daily market history to analyze this symbol.");
        const prediction = await askPython(entry.symbol, rows);
        const lastRow = rows.at(-1);
        prediction.price = latestPrices[entry.symbol] || Number(lastRow.close);
        const action = prediction.confidence < MIN_CONFIDENCE ? "HOLD" : prediction.signal;
        const note = action === "HOLD" && prediction.signal !== "HOLD"
          ? `Confidence below ${Math.round(MIN_CONFIDENCE * 100)}% threshold; review only`
          : "Review signal and place a paper order manually";
        latestPrices[entry.symbol] = prediction.price;
        if (portfolio.holdings[entry.symbol]) portfolio.holdings[entry.symbol].price = prediction.price;
        prediction.dataSource = "Upstox historical candles";
        prediction.dataDate = lastRow.date;
        results.push({ ...prediction, signal: action, rawSignal: prediction.signal, note });
      } catch (error) { results.push({ symbol: entry.symbol, error: error.message }); }
    }
    portfolio.lastScan = new Date().toISOString();
    savePortfolio(portfolio);
    res.json({ results, portfolio: publicPortfolio(portfolio) });
  } catch (error) { res.status(502).json({ error: `Market scan failed: ${error.message}` }); }
});

app.post("/api/chat", async (req, res) => {
  const message = String(req.body?.message || "").trim();
  if (!message) return res.status(400).json({ error: "Type a message first." });
  const context = JSON.stringify({
    stocks: req.body?.context?.stocks || [],
    models: req.body?.context?.ideas || [],
    portfolio: req.body?.context?.portfolio || {},
  });
  const instructions = `You are a beginner-friendly assistant inside a paper-trading learning app. Explain charts, indicators, model comparisons, and paper portfolio data using plain language. Use the current app context below, and say when it lacks enough data. Never promise returns or issue a confident buy/sell recommendation. Do not place orders. Explain that indicators and models can be wrong.\n\nApp context: ${context}`;
  const messages = (Array.isArray(req.body?.messages) ? req.body.messages : [{ role: "user", content: message }])
    .filter((item) => ["user", "assistant"].includes(item.role) && typeof item.content === "string")
    .slice(-10);

  if (!process.env.OPENAI_API_KEY) {
    const question = message.toLowerCase();
    let reply = "I can explain this dashboard, its charts, indicators, and model comparison. Try asking what RSI means or how the models differ.";
    if (question.includes("rsi")) reply = "RSI measures recent price momentum from 0 to 100. People often watch 30 and 70 as possible oversold and overbought zones, but RSI alone is not a trade signal.";
    else if (question.includes("macd")) reply = "MACD compares two moving averages to show momentum. A crossover can be a clue, but it can also give false signals when prices move sideways.";
    else if (question.includes("model") || question.includes("accuracy")) reply = "The comparison shows how each model did on older candles held aside during training. A stronger past score does not mean it will predict the next move correctly.";
    else if (question.includes("indicator")) reply = "The app checks RSI, MACD, and price versus its 20-day and 50-day averages. These are clues to review together, not automatic instructions.";
    else if (question.includes("portfolio") || question.includes("profit") || question.includes("p&l")) reply = `Your virtual account value is ₹${Number(req.body?.context?.portfolio?.total || 0).toLocaleString("en-IN")}. All orders here are simulated.`;
    else if (question.includes("data") || question.includes("price")) reply = "The dashboard polls Upstox market snapshots every minute while it is open. The model uses Upstox historical daily candles; the chart can also show today's one-minute candles.";
    return res.json({ reply, mode: "built-in helper" });
  }

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || "gpt-5-mini", instructions, input: messages, max_output_tokens: 350 }),
      signal: AbortSignal.timeout(25000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `Chat service returned HTTP ${response.status}.`);
    const reply = (data.output || []).flatMap((item) => item.content || []).filter((item) => item.type === "output_text").map((item) => item.text).join("\n");
    res.json({ reply: reply || "I couldn't form a reply. Try asking in a different way.", mode: "AI assistant" });
  } catch (error) { res.status(502).json({ error: `Chatbot request failed: ${error.message}` }); }
});

app.post("/api/orders", (req, res) => {
  const { symbol, side, quantity } = req.body || {};
  if (!WATCHLIST.some((entry) => entry.symbol === symbol)) return res.status(400).json({ error: "Choose a symbol from the watchlist." });
  if (!["BUY", "SELL"].includes(side)) return res.status(400).json({ error: "Order side must be BUY or SELL." });
  if (!Number.isInteger(quantity) || quantity < 1) return res.status(400).json({ error: "Enter a whole number of shares greater than zero." });
  const price = latestPrices[symbol];
  if (!Number.isFinite(price)) return res.status(400).json({ error: "Refresh daily market data first to get a paper reference price." });
  const portfolio = loadPortfolio();
  const value = price * quantity;
  const position = portfolio.holdings[symbol];
  if (side === "BUY") {
    if (value > portfolio.cash) return res.status(400).json({ error: "Not enough virtual cash for this order." });
    if (value > totalValue(portfolio) * (portfolio.maxOrderPercent || MAX_ORDER_PERCENT) / 100) return res.status(400).json({ error: `Order exceeds the ${portfolio.maxOrderPercent || MAX_ORDER_PERCENT}% per-order limit.` });
    const priorQty = position?.qty || 0;
    const priorCost = priorQty * (position?.avgPrice || price);
    const newQty = priorQty + quantity;
    portfolio.holdings[symbol] = { qty: newQty, price, avgPrice: Number(((priorCost + value) / newQty).toFixed(2)) };
    portfolio.cash = Number((portfolio.cash - value).toFixed(2));
  } else {
    if (!position || quantity > position.qty) return res.status(400).json({ error: "You do not hold enough shares to sell that quantity." });
    portfolio.cash = Number((portfolio.cash + value).toFixed(2));
    if (quantity === position.qty) delete portfolio.holdings[symbol];
    else portfolio.holdings[symbol] = { ...position, qty: position.qty - quantity, price };
  }
  const orderRecord = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, symbol, side, quantity, price, time: new Date().toISOString(), mode: "PAPER" };
  portfolio.orders.push(orderRecord);
  savePortfolio(portfolio);
  res.json({ order: orderRecord, portfolio: publicPortfolio(portfolio) });
});

app.post("/api/options/orders", (req, res) => {
  const { instrumentKey, lots } = req.body || {};
  const live = latestOptionQuotes.get(instrumentKey);
  const contract = optionContracts.get(instrumentKey);
  if (!live || !contract) return res.status(400).json({ error: "Refresh the option chain before placing a paper order." });
  if (!Number.isInteger(lots) || lots < 1) return res.status(400).json({ error: "Enter at least one whole lot." });
  const price = Number(live.market?.ltp);
  const quantity = Number(contract.lot_size) * lots;
  const value = price * quantity;
  const portfolio = loadPortfolio();
  if (!Number.isFinite(price) || price <= 0) return res.status(400).json({ error: "No valid option premium is available." });
  if (value > portfolio.cash) return res.status(400).json({ error: "Not enough virtual cash for this option order." });
  const prior = portfolio.optionHoldings[instrumentKey];
  const priorQuantity = prior?.quantity || 0;
  const totalQuantity = priorQuantity + quantity;
  const avgPrice = (priorQuantity * (prior?.avgPrice || price) + value) / totalQuantity;
  portfolio.optionHoldings[instrumentKey] = { ...live, lots: (prior?.lots || 0) + lots, quantity: totalQuantity, price, avgPrice: Number(avgPrice.toFixed(2)) };
  portfolio.cash = Number((portfolio.cash - value).toFixed(2));
  portfolio.optionOrders.push({ id: `${Date.now()}`, instrumentKey, side: "BUY", lots, quantity, price, value, time: new Date().toISOString(), mode: "PAPER" });
  savePortfolio(portfolio);
  res.json({ portfolio: publicPortfolio(portfolio) });
});

app.post("/api/options/positions/sell", (req, res) => {
  const { instrumentKey, lots } = req.body || {};
  const portfolio = loadPortfolio();
  const position = portfolio.optionHoldings[instrumentKey];
  const live = latestOptionQuotes.get(instrumentKey);
  const contract = optionContracts.get(instrumentKey);
  if (!position) return res.status(400).json({ error: "There is no paper position in this option." });
  if (!live || !contract) return res.status(400).json({ error: "Refresh the option chain before closing this paper position." });
  if (!Number.isInteger(lots) || lots < 1 || lots > position.lots) return res.status(400).json({ error: "Choose a valid number of lots to sell." });
  const quantity = Number(contract.lot_size) * lots;
  const price = Number(live.market?.ltp);
  portfolio.cash = Number((portfolio.cash + quantity * price).toFixed(2));
  if (lots === position.lots) delete portfolio.optionHoldings[instrumentKey];
  else portfolio.optionHoldings[instrumentKey] = { ...position, lots: position.lots - lots, quantity: position.quantity - quantity, price };
  portfolio.optionOrders.push({ id: `${Date.now()}`, instrumentKey, side: "SELL", lots, quantity, price, value: quantity * price, time: new Date().toISOString(), mode: "PAPER" });
  savePortfolio(portfolio);
  res.json({ portfolio: publicPortfolio(portfolio) });
});

app.post("/api/reset", (req, res) => {
  latestPrices = {};
  const portfolio = emptyPortfolio();
  savePortfolio(portfolio);
  res.json(publicPortfolio(portfolio));
});

app.listen(3000, () => console.log("Udgata-Algo server running on http://localhost:3000"));
