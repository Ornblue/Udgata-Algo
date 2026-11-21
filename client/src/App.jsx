import { useEffect, useState } from "react";

const money = (value) => "₹" + Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const percent = (value) => (Number(value || 0) * 100).toFixed(1) + "%";

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function PriceChart({ candles }) {
  if (!candles?.length) return <div className="empty">Load a chart to see prices.</div>;
  const rows = candles.slice(-120);
  const values = rows.map((c) => Number(c.close));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const point = (value, index) => [44 + index * (700 / Math.max(1, values.length - 1)), 225 - ((value - min) / range) * 190];
  const pricePath = values.map((v, i) => (i ? "L" : "M") + point(v, i).join(" ")).join(" ");
  const averages = values.map((_, i) => i < 19 ? null : values.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20);
  const averagePath = averages.map((v, i) => v == null ? "" : (i < 19 ? "M" : "L") + point(v, i).join(" ")).filter(Boolean).join(" ");
  return <div className="chart-box"><svg viewBox="0 0 760 260" role="img" aria-label="Price chart">
    <line x1="44" y1="35" x2="744" y2="35" /><line x1="44" y1="130" x2="744" y2="130" /><line x1="44" y1="225" x2="744" y2="225" />
    <text x="2" y="40">{money(max)}</text><text x="2" y="135">{money((min + max) / 2)}</text><text x="2" y="230">{money(min)}</text>
    <path className="price-line" d={pricePath} /><path className="average-line" d={averagePath} />
  </svg><div className="chart-legend"><span className="legend-price">Price</span><span className="legend-average">20 candle average</span></div>
  <small>{rows[0]?.date?.slice(0, 10)} to {rows.at(-1)?.date?.slice(0, 10)} · {rows.length} candles</small></div>;
}

function ModelComparison({ ideas }) {
  const items = (ideas || []).filter((item) => item.models?.length);
  if (!items.length) return <div className="empty">Run a scan to compare the models.</div>;
  return <div className="table-scroll"><table><thead><tr><th>Stock</th><th>Logistic regression</th><th>Random forest</th><th>Gradient boosting</th><th>Vote</th><th>Holdout score</th></tr></thead>
    <tbody>{items.map((item) => <tr key={item.symbol}><td>{item.symbol}</td>{item.models.map((model) => <td key={model.name}>{model.signal} · {percent(model.accuracy)}</td>)}<td><b>{item.signal}</b></td><td>{percent(item.accuracy)}</td></tr>)}</tbody></table></div>;
}

function App() {
  const [tab, setTab] = useState("Dashboard");
  const [status, setStatus] = useState({});
  const [stocks, setStocks] = useState([]);
  const [portfolio, setPortfolio] = useState(null);
  const [symbol, setSymbol] = useState("TCS");
  const [interval, setInterval] = useState("day");
  const [candles, setCandles] = useState([]);
  const [ideas, setIdeas] = useState([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [expiry, setExpiry] = useState("");
  const [expiries, setExpiries] = useState([]);
  const [chain, setChain] = useState([]);
  const [underlying, setUnderlying] = useState("NIFTY");
  const [chat, setChat] = useState([{ role: "assistant", content: "Hi! Ask me about the chart, indicators, model scores, or your paper account." }]);
  const [chatInput, setChatInput] = useState("");
  const [order, setOrder] = useState(null);
  const [optionOrder, setOptionOrder] = useState(null);
  const [lots, setLots] = useState(1);

  async function refreshMarket() {
    try {
      const data = await api("/api/market/stocks");
      setStocks(data.stocks || []);
      setPortfolio(data.portfolio);
      setError("");
    } catch (e) { setError(e.message); }
  }

  async function loadChart() {
    try {
      const path = interval === "day" ? "/api/market/history?symbol=" + symbol + "&days=180" : "/api/market/intraday?symbol=" + symbol;
      const data = await api(path);
      setCandles(data.candles || []);
    } catch (e) { setError(e.message); setCandles([]); }
  }

  async function scanModels() {
    setBusy(true);
    try {
      const data = await api("/api/run-agent", { method: "POST" });
      setIdeas(data.results || []);
      setPortfolio(data.portfolio);
      setMessage("Model comparison finished. Review the scores and signals.");
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function loadOptionChain() {
    if (!expiry) return;
    try {
      const data = await api("/api/options/chain?underlying=" + underlying + "&expiry=" + expiry);
      setChain(data.rows || []);
      if (data.portfolio) setPortfolio(data.portfolio);
    } catch (e) { setError(e.message); }
  }

  async function sendChat(event) {
    event.preventDefault();
    const text = chatInput.trim();
    if (!text) return;
    const next = [...chat, { role: "user", content: text }];
    setChat(next);
    setChatInput("");
    try {
      const result = await api("/api/chat", {
        method: "POST",
        body: JSON.stringify({ message: text, messages: next.slice(-10), context: { stocks, ideas, portfolio } }),
      });
      setChat([...next, { role: "assistant", content: result.reply, mode: result.mode }]);
    } catch (e) {
      setChat([...next, { role: "assistant", content: e.message }]);
    }
  }

  async function submitOrder(event) {
    event.preventDefault();
    try {
      const data = await api("/api/orders", {
        method: "POST",
        body: JSON.stringify({ symbol: order.symbol, side: order.side, quantity: Number(order.quantity) }),
      });
      setPortfolio(data.portfolio);
      setMessage("Paper order saved.");
      setOrder(null);
    } catch (e) { setError(e.message); }
  }

  async function submitOptionOrder(event) {
    event.preventDefault();
    const selling = optionOrder.side === "SELL";
    try {
      const data = await api(selling ? "/api/options/positions/sell" : "/api/options/orders", {
        method: "POST",
        body: JSON.stringify({ instrumentKey: optionOrder.instrumentKey, lots: Number(lots) }),
      });
      setPortfolio(data.portfolio);
      setMessage("Option paper order saved.");
      setOptionOrder(null);
    } catch (e) { setError(e.message); }
  }

  useEffect(() => {
    api("/api/status").then(setStatus).catch((e) => setError(e.message));
    api("/api/portfolio").then(setPortfolio).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!status.connected) return;
    refreshMarket();
    const timer = window.setInterval(refreshMarket, 60000);
    return () => window.clearInterval(timer);
  }, [status.connected]);

  useEffect(() => {
    if (!status.connected || (tab !== "Dashboard" && tab !== "Analysis")) return;
    loadChart();
    const timer = interval === "minute" ? window.setInterval(loadChart, 60000) : null;
    return () => timer && window.clearInterval(timer);
  }, [tab, symbol, interval, status.connected]);

  useEffect(() => {
    if (tab !== "Options" || !status.optionsAvailable) return;
    let alive = true;
    api("/api/options/expiries?underlying=" + underlying).then((data) => {
      if (!alive) return;
      setExpiries(data.expiries || []);
      if (!data.expiries?.includes(expiry)) setExpiry(data.expiries?.[0] || "");
    }).catch((e) => setError(e.message));
    return () => { alive = false; };
  }, [tab, underlying, status.optionsAvailable]);

  useEffect(() => {
    if (tab !== "Options" || !expiry || !status.optionsAvailable) return;
    loadOptionChain();
    const timer = window.setInterval(loadOptionChain, 60000);
    return () => window.clearInterval(timer);
  }, [tab, expiry, underlying, status.optionsAvailable]);

  const nav = ["Dashboard", "Analysis", "Options", "Chatbot", "Portfolio"];
  const total = portfolio?.total || portfolio?.cash || 0;
  const equityPnl = Object.values(portfolio?.holdings || {}).reduce((sum, p) => sum + p.qty * (p.price - p.avgPrice), 0);
  const optionPnl = Object.values(portfolio?.optionHoldings || {}).reduce((sum, p) => sum + p.quantity * (p.price - p.avgPrice), 0);

  return <main className="app">
    <header className="top">
      <div><h1>Udgata-Algo</h1><p>Indian market learning dashboard · Paper trading</p></div>
      <div className="connection">{status.connected ? "Upstox connected" : "Upstox token needed"}</div>
    </header>
    <nav className="nav">{nav.map((name) => <button key={name} className={tab === name ? "active" : ""} onClick={() => setTab(name)}>{name}</button>)}</nav>
    {error && <div className="alert error">{error}<button onClick={() => setError("")}>Close</button></div>}
    {message && <div className="alert">{message}<button onClick={() => setMessage("")}>Close</button></div>}

    {!status.connected && <section className="setup"><b>Connect free Upstox market data</b><p>Put your token in <code>server/.env</code> as <code>UPSTOX_ANALYTICS_TOKEN=...</code>, then restart the server. For AI chat, optionally add <code>OPENAI_API_KEY=...</code>. Without that key, the built-in help bot still works.</p></section>}

    {tab === "Dashboard" && <>
      <section className="summary">
        <div><span>Paper account</span><strong>{money(total)}</strong></div>
        <div><span>Available cash</span><strong>{money(portfolio?.cash)}</strong></div>
        <div><span>Unrealized P&amp;L</span><strong className={(equityPnl + optionPnl) >= 0 ? "up" : "down"}>{money(equityPnl + optionPnl)}</strong></div>
        <div><span>Market data</span><strong>{status.connected ? "Updates every minute" : "Not connected"}</strong></div>
      </section>
      <section className="box">
        <div className="section-head"><div><h2>Market prices</h2><p>Four stocks in the current watchlist.</p></div><button onClick={refreshMarket} disabled={!status.connected}>Refresh</button></div>
        <div className="table-scroll"><table><thead><tr><th>Symbol</th><th>Price</th><th>Change</th><th>Open</th><th>High</th><th>Low</th><th>Volume</th></tr></thead>
          <tbody>{stocks.map((stock) => <tr key={stock.symbol}><td><button className="link" onClick={() => { setSymbol(stock.symbol); setTab("Analysis"); }}>{stock.symbol}</button></td><td>{money(stock.price)}</td><td className={stock.change >= 0 ? "up" : "down"}>{money(stock.change)} ({Number(stock.changePercent || 0).toFixed(2)}%)</td><td>{money(stock.open)}</td><td>{money(stock.high)}</td><td>{money(stock.low)}</td><td>{Number(stock.volume || 0).toLocaleString("en-IN")}</td></tr>)}</tbody></table></div>
      </section>
      <section className="box">
        <div className="section-head"><div><h2>Price chart</h2><p>{symbol} · candles from Upstox</p></div><div className="controls"><select value={symbol} onChange={(e) => setSymbol(e.target.value)}>{stocks.map((s) => <option key={s.symbol}>{s.symbol}</option>)}</select><button className={interval === "day" ? "chosen" : ""} onClick={() => setInterval("day")}>Daily</button><button className={interval === "minute" ? "chosen" : ""} onClick={() => setInterval("minute")}>1 minute</button></div></div>
        <PriceChart candles={candles} />
      </section>
      <div className="footer-note">This is a learning app. All orders are simulated and no broker orders are sent.</div>
    </>}

    {tab === "Analysis" && <>
      <section className="box">
        <div className="section-head"><div><h2>Signals and models</h2><p>Three small models learn from historical Upstox daily candles.</p></div><button onClick={scanModels} disabled={busy || !status.connected}>{busy ? "Training..." : "Train and compare"}</button></div>
        <ModelComparison ideas={ideas} />
      </section>
      {ideas.length > 0 && <section className="box"><h2>Indicator readings</h2><div className="table-scroll"><table><thead><tr><th>Stock</th><th>RSI (14)</th><th>MACD</th><th>20 day average</th><th>50 day average</th><th>Bollinger range</th><th>Volume vs average</th></tr></thead>
        <tbody>{ideas.filter((i) => i.indicators).map((item) => <tr key={item.symbol}><td>{item.symbol}</td><td>{item.indicators.rsi14} · {item.indicators.rsiSignal}</td><td>{item.indicators.macdSignalText}</td><td>{money(item.indicators.sma20)}</td><td>{money(item.indicators.sma50)}</td><td>{money(item.indicators.bollingerLow)} – {money(item.indicators.bollingerHigh)}</td><td>{item.indicators.volumeRatio == null ? "—" : item.indicators.volumeRatio + "×"}</td></tr>)}</tbody></table></div></section>}
      <section className="box"><div className="section-head"><div><h2>Chart and signals</h2><p>Daily prices, one-minute intraday candles, and 20-candle average.</p></div><div className="controls"><select value={symbol} onChange={(e) => setSymbol(e.target.value)}>{stocks.map((s) => <option key={s.symbol}>{s.symbol}</option>)}</select><button onClick={() => setInterval("day")}>Daily</button><button onClick={() => setInterval("minute")}>1 minute</button></div></div><PriceChart candles={candles} /></section>
    </>}

    {tab === "Options" && <>
      {!status.optionsAvailable ? <section className="box"><h2>Options need Upstox setup</h2><p>Add your Analytics Token to <code>server/.env</code> to load option chains.</p></section> : <>
        <section className="box"><div className="section-head"><div><h2>Option chain</h2><p>Data and paper orders refresh every minute.</p></div><div className="controls"><select value={underlying} onChange={(e) => { setUnderlying(e.target.value); setExpiry(""); }}><option value="NIFTY">NIFTY 50</option><option value="BANKNIFTY">NIFTY BANK</option><option value="FINNIFTY">FINNIFTY</option><option value="TCS">TCS</option><option value="INFY">INFY</option><option value="RELIANCE">RELIANCE</option><option value="HDFCBANK">HDFCBANK</option></select><select value={expiry} onChange={(e) => setExpiry(e.target.value)}><option value="">Select expiry</option>{expiries.map((date) => <option key={date}>{date}</option>)}</select><button onClick={loadOptionChain}>Refresh</button></div></div>
          <div className="table-scroll"><table><thead><tr><th>Call premium</th><th>Call OI</th><th>Call bid/ask</th><th>Strike</th><th>Put premium</th><th>Put OI</th><th>Put bid/ask</th><th>Paper</th></tr></thead><tbody>{chain.map((row) => <tr key={row.strike}><td>{money(row.call?.market?.ltp)}</td><td>{row.call?.market?.oi}</td><td>{money(row.call?.market?.bid_price)} / {money(row.call?.market?.ask_price)}</td><td><b>{Number(row.strike).toLocaleString("en-IN")}</b></td><td>{money(row.put?.market?.ltp)}</td><td>{row.put?.market?.oi}</td><td>{money(row.put?.market?.bid_price)} / {money(row.put?.market?.ask_price)}</td><td><button disabled={!row.call?.instrumentKey} onClick={() => { setOptionOrder({ ...row.call, side: "BUY", underlying, strike: row.strike, expiry, type: "CE" }); setLots(1); }}>Buy CE</button> <button disabled={!row.put?.instrumentKey} onClick={() => { setOptionOrder({ ...row.put, side: "BUY", underlying, strike: row.strike, expiry, type: "PE" }); setLots(1); }}>Buy PE</button></td></tr>)}</tbody></table></div>
        </section>
        {Object.entries(portfolio?.optionHoldings || {}).length > 0 && <section className="box"><h2>Open option paper positions</h2><div className="table-scroll"><table><thead><tr><th>Contract</th><th>Lots</th><th>Average premium</th><th>Latest premium</th><th>P&amp;L</th><th></th></tr></thead><tbody>{Object.entries(portfolio.optionHoldings).map(([key, position]) => <tr key={key}><td>{position.underlying} {position.strike} {position.type} · {position.expiry}</td><td>{position.lots}</td><td>{money(position.avgPrice)}</td><td>{money(position.price)}</td><td>{money(position.quantity * (position.price - position.avgPrice))}</td><td><button onClick={() => { setOptionOrder({ ...position, instrumentKey: key, side: "SELL" }); setLots(1); }}>Sell</button></td></tr>)}</tbody></table></div></section>}
      </>}
    </>}

    {tab === "Chatbot" && <section className="box chat-box"><h2>Market helper</h2><p>Ask about your data, indicators, paper trades, or model scores.</p><div className="messages">{chat.map((item, i) => <div key={i} className={"bubble " + item.role}><b>{item.role === "user" ? "You" : "Helper"}</b><p>{item.content}</p></div>)}</div><form className="chat-form" onSubmit={sendChat}><input value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder="For example: what does RSI mean?" /><button>Send</button></form><small>Optional AI replies use the key in server/.env. No key? Built-in helper stays available.</small></section>}

    {tab === "Portfolio" && <>
      <section className="box"><div className="section-head"><div><h2>Paper positions</h2><p>Virtual orders only. Your account starts with ₹1,00,000.</p></div></div>
        <div className="table-scroll"><table><thead><tr><th>Stock</th><th>Shares</th><th>Average price</th><th>Latest price</th><th>Value</th><th>P&amp;L</th><th></th></tr></thead><tbody>{Object.entries(portfolio?.holdings || {}).map(([key, p]) => <tr key={key}><td>{key}</td><td>{p.qty}</td><td>{money(p.avgPrice)}</td><td>{money(p.price)}</td><td>{money(p.qty * p.price)}</td><td>{money(p.qty * (p.price - p.avgPrice))}</td><td><button onClick={() => setOrder({ symbol: key, side: "SELL", price: p.price, quantity: p.qty })}>Sell</button></td></tr>)}</tbody></table></div>
        {Object.keys(portfolio?.holdings || {}).length === 0 && <div className="empty">No stock positions yet. Pick a symbol above and create a paper buy.</div>}
        <h3>Try a paper stock order</h3><div className="paper-trade">{stocks.map((s) => <button key={s.symbol} onClick={() => setOrder({ symbol: s.symbol, side: "BUY", price: s.price, quantity: 1 })}>Paper buy {s.symbol}</button>)}</div>
        <button className="plain-button" onClick={async () => { if (!window.confirm("Reset your paper account?")) return; try { const data = await api("/api/reset", { method: "POST" }); setPortfolio(data); setIdeas([]); } catch (e) { setError(e.message); } }}>Reset paper account</button>
      </section>
      <section className="box"><h2>Order history</h2><div className="table-scroll"><table><thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Shares</th><th>Fill price</th></tr></thead><tbody>{[...(portfolio?.orders || [])].reverse().map((item) => <tr key={item.id}><td>{new Date(item.time).toLocaleString()}</td><td>{item.symbol}</td><td>{item.side}</td><td>{item.quantity}</td><td>{money(item.price)}</td></tr>)}</tbody></table></div></section>
    </>}

    {order && <div className="overlay" onClick={() => setOrder(null)}><form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submitOrder}><button className="close" type="button" onClick={() => setOrder(null)}>×</button><h2>{order.side} {order.symbol} · paper</h2><p>Reference price {money(order.price)}</p><label>Number of shares<input type="number" min="1" value={order.quantity} onChange={(e) => setOrder({ ...order, quantity: Number(e.target.value) })} /></label><button>Confirm paper order</button></form></div>}
    {optionOrder && <div className="overlay" onClick={() => setOptionOrder(null)}><form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submitOptionOrder}><button className="close" type="button" onClick={() => setOptionOrder(null)}>×</button><h2>{optionOrder.side} {optionOrder.underlying} {optionOrder.strike} {optionOrder.type} · paper</h2><p>Expiry {optionOrder.expiry} · last premium {money(optionOrder.market?.ltp)}</p><label>Lots<input type="number" min="1" max={optionOrder.side === "SELL" ? portfolio?.optionHoldings?.[optionOrder.instrumentKey]?.lots || 1 : undefined} value={lots} onChange={(e) => setLots(e.target.value)} /></label><p>Estimated premium: {money(Number(lots) * Number(optionOrder.lotSize) * Number(optionOrder.market?.ltp || 0))}</p><button>Confirm paper order</button></form></div>}
  </main>;
}

export default App;
