// index.js
const http = require("http");
const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");

const BINANCE_WS = (symbol = "btcusdt", interval = "1m") =>
  `wss://stream.binance.com:9443/ws/${symbol}@kline_${interval}`;

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wssServer = new WebSocket.Server({ server }); // clients connect to this

const PORT = process.env.PORT || 5000;

// Simple in-memory storage
let ohlc = []; // [{t, open, high, low, close, volume}, ...]
let lastSignal = null;

// --- Helpers: EMA and RSI (simple implementations) ---
function ema(values, length) {
  const out = new Array(values.length).fill(null);
  if (values.length === 0) return out;
  const k = 2 / (length + 1);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  const deltas = [];
  for (let i = 1; i < values.length; i++) deltas.push(values[i] - values[i - 1]);
  let gain = 0,
    loss = 0;
  for (let i = 0; i < period; i++) {
    const d = deltas[i];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period,
    avgLoss = loss / period;
  out[period] = 100 - 100 / (1 + avgGain / (avgLoss || 1e-8));
  for (let i = period + 1; i < values.length; i++) {
    const d = deltas[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = 100 - 100 / (1 + avgGain / (avgLoss || 1e-8));
  }
  return out;
}

// broadcast helper
function broadcast(type, data) {
  const payload = JSON.stringify({ type, data });
  wssServer.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(payload);
  });
}

// Very simple analyzer: EMA crossover + RSI thresholds
function analyzeAndSignal(ohlcArr) {
  const closes = ohlcArr.map((d) => d.close);
  const emaShortLen = 9;
  const emaLongLen = 21;
  const rsiPeriod = 14;
  const rsiBuy = 45;
  const rsiSell = 65;

  const emaS = ema(closes, emaShortLen);
  const emaL = ema(closes, emaLongLen);
  const rsiArr = rsi(closes, rsiPeriod);

  const i = closes.length - 1;
  if (i <= emaLongLen) return { signal: "HOLD", reason: "not enough data" };

  const prev = i - 1;
  const crossedUp = emaS[prev] <= emaL[prev] && emaS[i] > emaL[i];
  const crossedDown = emaS[prev] >= emaL[prev] && emaS[i] < emaL[i];

  const r = Math.round(rsiArr[i] ?? 50);
  const price = closes[i];

  if (crossedUp && r < rsiBuy) {
    const entry = price;
    const stopLoss = +(entry - 0.5 * (Math.abs(emaS[i] - emaL[i]) || 1)).toFixed(2);
    const takeProfit = +(entry + 1.5 * (Math.abs(emaS[i] - emaL[i]) || 1)).toFixed(2);
    const confidence = Math.min(0.95, 0.6 + (rsiBuy - r) / 100);
    return {
      signal: "BUY",
      entry,
      stopLoss,
      takeProfit,
      confidence: +confidence.toFixed(2),
      reason: `EMA up cross + RSI ${r}`,
      price,
      rsi: r,
    };
  } else if (crossedDown && r > rsiSell) {
    const entry = price;
    const stopLoss = +(entry + 0.5 * (Math.abs(emaS[i] - emaL[i]) || 1)).toFixed(2);
    const takeProfit = +(entry - 1.5 * (Math.abs(emaS[i] - emaL[i]) || 1)).toFixed(2);
    const confidence = Math.min(0.95, 0.6 + (r - rsiSell) / 100);
    return {
      signal: "SELL",
      entry,
      stopLoss,
      takeProfit,
      confidence: +confidence.toFixed(2),
      reason: `EMA down cross + RSI ${r}`,
      price,
      rsi: r,
    };
  } else {
    return { signal: "HOLD", reason: `No crossover (RSI ${r})`, price, rsi: r };
  }
}

// --- Connect to Binance kline websocket for a symbol
const SYMBOL = process.env.SYMBOL || "btcusdt";
const INTERVAL = process.env.INTERVAL || "1m";
let binanceSocket = null;

function connectBinance() {
  const url = BINANCE_WS(SYMBOL, INTERVAL);
  console.log("Connecting to Binance WS:", url);
  binanceSocket = new WebSocket(url);

  binanceSocket.on("open", () => {
    console.log("Connected to Binance stream for", SYMBOL, INTERVAL);
  });

  binanceSocket.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (!data.k) return;
      const k = data.k;
      const candle = {
        t: k.t, // open time
        open: parseFloat(k.o),
        high: parseFloat(k.h),
        low: parseFloat(k.l),
        close: parseFloat(k.c),
        volume: parseFloat(k.v),
        isFinal: k.x, // whether candle closed
      };

      // Always send price ticks for chart (use last close or current)
      broadcast("price", { t: candle.t, close: candle.close });

      if (candle.isFinal) {
        // push to OHLC and keep max 200
        ohlc.push(candle);
        if (ohlc.length > 500) ohlc.shift();

        // analyze and broadcast signal
        const result = analyzeAndSignal(ohlc);
        lastSignal = { ...result, symbol: SYMBOL, ts: Date.now() };
        console.log("Signal ->", lastSignal.signal, lastSignal.reason || "");
        broadcast("signal", lastSignal);
      }
    } catch (e) {
      console.error("binance parse error", e);
    }
  });

  binanceSocket.on("close", () => {
    console.log("Binance WS closed, reconnecting in 3s...");
    setTimeout(connectBinance, 3000);
  });

  binanceSocket.on("error", (err) => {
    console.error("Binance WS error", err.message || err);
    binanceSocket.terminate();
  });
}

// Start Binance connection
connectBinance();

// --- Routes for HTTP fallback / testing
app.get("/", (req, res) => res.json({ message: "Backend connected (Binance live)" }));

app.get("/api/last-signal", (req, res) => {
  if (lastSignal) res.json(lastSignal);
  else res.json({});
});

app.get("/api/ohlc", (req, res) => res.json(ohlc.slice(-200)));

app.post("/push-ohlc", (req, res) => {
  const arr = req.body;
  if (!Array.isArray(arr)) return res.status(400).json({ ok: false, reason: "send array" });
  ohlc = arr.slice(-500);
  return res.json({ ok: true, count: ohlc.length });
});

// Start server (HTTP + WS)
server.listen(PORT, () => {
  console.log(`Server listening on ${PORT} (serves WS to frontend).`);
  console.log(`Binance symbol: ${SYMBOL} interval: ${INTERVAL}`);
});

// When a client connects to our wssServer, send lastSignal if exists
wssServer.on("connection", (ws) => {
  console.log("Frontend client connected (WS).");
  if (lastSignal) ws.send(JSON.stringify({ type: "signal", data: lastSignal }));
  ws.send(JSON.stringify({ type: "status", data: "connected" }));
});
