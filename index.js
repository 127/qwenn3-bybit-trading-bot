import crypto from "crypto";
import nodeFetch from "node-fetch";
import OpenAI from "openai";
import TelegramBot from "node-telegram-bot-api";
import invariant from "tiny-invariant";
import dotenv from "dotenv";
import { bybit_template } from "./prompts.js";

dotenv.config();

function requireEnv(name) {
    const value = process.env[name];
    invariant(value, `Missing required environment variable ${name}`);
    return value;
}

const TELEGRAM_CHAT_ID = requireEnv("TELEGRAM_CHAT_ID");
const TELEGRAM_BOT_TOKEN = requireEnv("TELEGRAM_BOT_TOKEN");
const BYBIT_SYMBOL = "BTCUSDT";
const BYBIT_ACCOUNT_TYPE = "UNIFIED";
const BYBIT_CATEGORY = "linear";
const TARGET_LEVERAGE = 100;
const BYBIT_BASE_URL = requireEnv("BYBIT_BASE_URL");
const BYBIT_RECV_WINDOW = "5000";
const CRYPTO_HORDE_ENDPOINT = requireEnv("CRYPTO_HORDE_ENDPOINT");
const CRYPTO_HORDE_KEY = requireEnv("CRYPTO_HORDE_KEY");
const BYBIT_API_KEY = requireEnv("BYBIT_API_KEY");
const BYBIT_API_SECRET = requireEnv("BYBIT_API_SECRET");
const OPENAI_API_KEY = requireEnv("OPENAI_API_KEY");
const OPENAI_BASE_URL = requireEnv("OPENAI_BASE_URL");
const DEFAULT_QTY_STEP = 0.001; //0.001
const DEFAULT_TICK_SIZE = 0.5;
const MIN_EXECUTION_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const EXECUTION_INTERVAL_MS_RAW = requireEnv("EXECUTION_INTERVAL_MS");
const EXECUTION_INTERVAL_MS = Math.max(
    Number(EXECUTION_INTERVAL_MS_RAW) || MIN_EXECUTION_INTERVAL_MS,
    MIN_EXECUTION_INTERVAL_MS
);

const openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
    baseURL: OPENAI_BASE_URL
});

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
const leverageSettingsCache = new Map();

const SESSION_START = Date.now();

function assertBybitCredentials() {
    if (!BYBIT_API_KEY || !BYBIT_API_SECRET) {
        throw new Error(
            "Missing BYBIT_API_KEY/BYBIT_API_SECRET environment variables for unified account access."
        );
    }
}

function toNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function formatUsd(value) {
    return Number(value).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function formatPercent(value) {
    return `${(value * 100).toFixed(1)}%`;
}

function formatBigNumber(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return "0";
    if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
    if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
    if (num >= 1e3) return `${(num / 1e3).toFixed(2)}K`;
    return num.toFixed(0);
}

function quantizeToStep(value, step, mode = "floor") {
    if (!Number.isFinite(value)) {
        return 0;
    }
    if (!Number.isFinite(step) || step <= 0) {
        return value;
    }
    const ratio = value / step;
    const units =
        mode === "ceil" ? Math.ceil(ratio) : mode === "round" ? Math.round(ratio) : Math.floor(ratio);
    return Number((units * step).toFixed(8));
}

function fillTemplate(template, params) {
    const missingKeys = new Set();
    const filled = template.replace(/\{(\w+)\}/g, (_, key) => {
        if (params[key] === undefined || params[key] === null || params[key] === "") {
            missingKeys.add(key);
            return `{${key}}`;
        }
        return params[key];
    });

    if (missingKeys.size > 0) {
        throw new Error(
            `Missing template values for: ${Array.from(missingKeys).join(", ")}`
        );
    }

    return filled;
}

function createOutputFormatDescriptor() {
    return `{
  "decisions": [
    {
      "operation": "buy",
      "symbol": "${BYBIT_SYMBOL}",
      "target_portion_of_balance": 0.25,
      "leverage": ${TARGET_LEVERAGE},
      "max_price": 0,
      "stop_loss_price": 0,
      "take_profit_price": 0,
      "reason": "Concise catalyst describing why exposure is warranted.",
      "trading_strategy": "Risk outline covering stop level, target, and leverage rationale."
    },
    {
      "operation": "hold",
      "symbol": "${BYBIT_SYMBOL}",
      "target_portion_of_balance": 0.0,
      "leverage": ${TARGET_LEVERAGE},
      "reason": "Document why no trade is taken despite monitoring the symbol.",
      "trading_strategy": "Explain what would need to change to trigger an entry."
    }
  ]
}`;
}

function formatNewsTimestamp(isoString) {
    if (!isoString) return "Unknown time";
    const parsed = new Date(isoString);
    if (Number.isNaN(parsed.getTime())) return "Unknown time";
    return parsed.toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function summarizeNewsArticles(articles = []) {
    const topArticles = articles.slice(0, 4);
    if (!topArticles.length) {
        return "No fresh crypto headlines available right now.";
    }

    return topArticles
        .map((article) => {
            const timestamp = formatNewsTimestamp(article.published_at);
            const themeSuffix = article.theme ? ` (${article.theme})` : "";
            const bodyText = (article.body || article.title || "").trim();
            const preview = bodyText
                .replace(/\s+/g, " ")
                .slice(0, 160)
                .trim();
            return `• ${timestamp}${themeSuffix} – ${preview}`;
        })
        .join("\n");
}

async function fetchLatestNewsSummary() {
    const fetchImpl = typeof fetch === "function" ? fetch : nodeFetch;
    const url = `${CRYPTO_HORDE_ENDPOINT}?theme=crypto&lang=en&key=${CRYPTO_HORDE_KEY}`;

    try {
        const response = await fetchImpl(url, { method: "GET" });
        if (!response.ok) {
            throw new Error(`CryptoHorde HTTP ${response.status}`);
        }

        const payload = await response.json();
        if (!Array.isArray(payload)) {
            throw new Error("CryptoHorde response is not an array");
        }

        return {
            summary: summarizeNewsArticles(payload),
            articles: payload
        };
    } catch (error) {
        console.error("Failed to fetch crypto news:", error);
        return {
            summary: "Unable to load fresh crypto news; operating with default bias.",
            articles: []
        };
    }
}

function buildQueryString(params = {}) {
    return Object.entries(params)
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
        .join("&");
}

async function bybitRequest({
    path,
    method = "GET",
    query = {},
    body,
    auth = false
}) {
    const queryString = buildQueryString(query);
    const url = `${BYBIT_BASE_URL}${path}${queryString ? `?${queryString}` : ""}`;
    const headers = { "Content-Type": "application/json" };
    const options = { method, headers };

    let bodyPayload = "";
    if (body && method !== "GET") {
        bodyPayload = JSON.stringify(body);
        options.body = bodyPayload;
    }

    if (auth) {
        assertBybitCredentials();
        const timestamp = Date.now().toString();
        const signPayload = `${timestamp}${BYBIT_API_KEY}${BYBIT_RECV_WINDOW}${queryString}${method === "POST" ? bodyPayload : ""}`;
        const signature = crypto
            .createHmac("sha256", BYBIT_API_SECRET)
            .update(signPayload)
            .digest("hex");

        headers["X-BAPI-API-KEY"] = BYBIT_API_KEY;
        headers["X-BAPI-SIGN"] = signature;
        headers["X-BAPI-TIMESTAMP"] = timestamp;
        headers["X-BAPI-RECV-WINDOW"] = BYBIT_RECV_WINDOW;
    }

    const fetchImpl = typeof fetch === "function" ? fetch : nodeFetch;
    const response = await fetchImpl(url, options);
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Bybit HTTP ${response.status}: ${errorText}`);
    }

    const payload = await response.json();
    if (payload.retCode !== 0) {
        const error = new Error(`Bybit API error ${payload.retMsg} (code ${payload.retCode})`);
        error.code = payload.retCode;
        error.response = payload;
        throw error;
    }

    return payload.result;
}

function buildLeverageCacheKey(symbol = BYBIT_SYMBOL, category = BYBIT_CATEGORY) {
    return `${category}:${symbol}`;
}

async function ensureSymbolLeverage(symbol = BYBIT_SYMBOL, leverage, category = BYBIT_CATEGORY) {
    const normalizedLeverage = Number.isFinite(leverage)
        ? Math.min(TARGET_LEVERAGE, Math.max(1, Math.round(leverage)))
        : TARGET_LEVERAGE;
    const cacheKey = buildLeverageCacheKey(symbol, category);
    if (leverageSettingsCache.get(cacheKey) === normalizedLeverage) {
        return;
    }

    const body = {
        category,
        symbol,
        buyLeverage: normalizedLeverage.toString(),
        sellLeverage: normalizedLeverage.toString()
    };

    try {
        await bybitRequest({
            path: "/v5/position/set-leverage",
            method: "POST",
            body,
            auth: true
        });
        leverageSettingsCache.set(cacheKey, normalizedLeverage);
    } catch (error) {
        const errorMessage = error?.message ?? "";
        const isLeverageUnchanged =
            error?.code === 110043 || errorMessage.includes("code 110043");
        if (isLeverageUnchanged) {
            leverageSettingsCache.set(cacheKey, normalizedLeverage);
            return;
        }
        throw error;
    }
}

async function fetchUnifiedAccountSnapshot() {
    const result = await bybitRequest({
        path: "/v5/account/wallet-balance",
        query: { accountType: BYBIT_ACCOUNT_TYPE, coin: "USDT" },
        auth: true
    });

    const accountEntry = result?.list?.[0];
    if (!accountEntry) {
        throw new Error("Bybit wallet balance response missing account entry.");
    }

    const primaryCoin =
        accountEntry.coin?.find((coin) => coin.coin === "USDT") ??
        accountEntry.coin?.find((coin) => coin.coin === "USDC") ??
        accountEntry.coin?.[0];

    const totalEquity = toNumber(accountEntry.totalEquity ?? primaryCoin?.equity ?? 0);
    const availableBalance = toNumber(
        accountEntry.totalWalletBalance ??
        primaryCoin?.availableToWithdraw ??
        primaryCoin?.walletBalance ??
        0
    );
    const usedMargin = toNumber(
        accountEntry.totalPositionIM ??
        primaryCoin?.totalPositionIM ??
        primaryCoin?.positionIM ??
        0
    );
    const maintenanceMargin = toNumber(
        accountEntry.totalPositionMM ??
        primaryCoin?.totalPositionMM ??
        primaryCoin?.positionMM ??
        0
    );

    if (!Number.isFinite(totalEquity) || totalEquity <= 0) {
        console.warn("Received zero total equity from Bybit; check account balances.");
    }

    return {
        totalEquity,
        availableBalance,
        usedMargin,
        maintenanceMargin,
        accountType: accountEntry.accountType ?? BYBIT_ACCOUNT_TYPE,
        accountCurrency: primaryCoin?.coin ?? "USDT"
    };
}

async function fetchBtcusdtTicker() {
    const result = await bybitRequest({
        path: "/v5/market/tickers",
        query: { category: BYBIT_CATEGORY, symbol: BYBIT_SYMBOL }
    });

    const ticker = result?.list?.[0];
    if (!ticker) {
        throw new Error("Bybit ticker response missing BTCUSDT data.");
    }

    return {
        symbol: BYBIT_SYMBOL,
        price: toNumber(ticker.lastPrice),
        change24h: toNumber(ticker.price24hPcnt) * 100,
        fundingRate: toNumber(ticker.fundingRate),
        volume24h: toNumber(ticker.turnover24h)
    };
}

async function fetchBtcusdtInstrumentMeta() {
    const result = await bybitRequest({
        path: "/v5/market/instruments-info",
        query: { category: BYBIT_CATEGORY, symbol: BYBIT_SYMBOL }
    });

    const instrument = result?.list?.[0];
    if (!instrument) {
        throw new Error("Bybit instrument info missing BTCUSDT data.");
    }

    const lotSize = instrument.lotSizeFilter ?? {};
    const priceFilter = instrument.priceFilter ?? {};

    return {
        minOrderQty: toNumber(lotSize.minOrderQty, DEFAULT_QTY_STEP),
        maxOrderQty: toNumber(lotSize.maxOrderQty, Infinity),
        qtyStep: toNumber(lotSize.qtyStep, DEFAULT_QTY_STEP),
        tickSize: toNumber(priceFilter.tickSize, DEFAULT_TICK_SIZE),
        minPrice: toNumber(priceFilter.minPrice, 0),
        maxPrice: toNumber(priceFilter.maxPrice, Infinity)
    };
}

function determinePositionMode(positionEntries = []) {
    const hasHedgeIdx = positionEntries.some((entry) => {
        const idx = Number(entry.positionIdx);
        return idx === 1 || idx === 2;
    });
    return hasHedgeIdx ? "HEDGE" : "ONE_WAY";
}

async function fetchBtcusdtPositionState() {
    const result = await bybitRequest({
        path: "/v5/position/list",
        query: { category: BYBIT_CATEGORY, symbol: BYBIT_SYMBOL },
        auth: true
    });

    const entries = Array.isArray(result?.list) ? result.list : [];
    const rawPosition = entries.find((entry) => Number(entry.size) !== 0) ?? null;
    const positionMode = determinePositionMode(entries);

    if (!rawPosition) {
        return {
            position: null,
            positionMode
        };
    }

    return {
        position: {
            side: rawPosition.side,
            size: toNumber(rawPosition.size),
            entryPrice: toNumber(rawPosition.avgPrice ?? rawPosition.entryPrice),
            leverage: toNumber(rawPosition.leverage ?? TARGET_LEVERAGE),
            unrealisedPnl: toNumber(rawPosition.unrealisedPnl),
            positionValue: toNumber(rawPosition.positionValue),
            markPrice: toNumber(rawPosition.markPrice ?? rawPosition.markPrice),
            liqPrice: toNumber(rawPosition.liqPrice),
            takeProfit: toNumber(rawPosition.takeProfit),
            stopLoss: toNumber(rawPosition.stopLoss),
            positionIdx: Number(rawPosition.positionIdx)
        },
        positionMode
    };
}

async function fetchBybitKlines(interval, limit = 60) {
    const result = await bybitRequest({
        path: "/v5/market/kline",
        query: {
            category: BYBIT_CATEGORY,
            symbol: BYBIT_SYMBOL,
            interval,
            limit
        }
    });

    const rows = Array.isArray(result?.list) ? result.list : [];
    return rows.map((entry) => ({
        startTime: Number(entry?.[0]),
        open: toNumber(entry?.[1]),
        high: toNumber(entry?.[2]),
        low: toNumber(entry?.[3]),
        close: toNumber(entry?.[4]),
        volume: toNumber(entry?.[5])
    }));
}

async function fetchIntradaySeries() {
    const configs = [
        { label: "1m", interval: "1" },
        { label: "5m", interval: "5" },
        { label: "1h", interval: "60" }
    ];

    const results = await Promise.all(
        configs.map(async ({ label, interval }) => {
            try {
                const candles = await fetchBybitKlines(interval, 60);
                return [label, candles];
            } catch (error) {
                console.error(`Failed to load ${label} candles:`, error);
                return [label, []];
            }
        })
    );

    return Object.fromEntries(results);
}

function describePosition(position) {
    if (!position) {
        return "- BTCUSDT perp: Flat; ready to deploy 5x leverage on the next setup.";
    }

    const direction = position.side?.toUpperCase() ?? "LONG";
    const size = position.size.toFixed(4);
    const entry = formatUsd(position.entryPrice);
    const pnl = position.unrealisedPnl.toFixed(2);
    return `- BTCUSDT perp: ${direction} ${size} @ $${entry} | Lvg ${position.leverage}x | UPNL ${pnl} USDT`;
}

function formatCandleTimestamp(startTime) {
    if (!Number.isFinite(startTime)) {
        return "??:??";
    }
    const iso = new Date(startTime).toISOString();
    return iso.slice(11, 16); // HH:MM
}

function formatCandlePrice(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
        return "0.00";
    }
    return num.toFixed(2);
}

function formatSeriesSection(label, candles = []) {
    if (!candles.length) {
        return `${label}: No candle data available.`;
    }

    const recent = candles
        .slice()
        .sort((a, b) => a.startTime - b.startTime)
        .slice(-3);

    const entries = recent.map((candle) => {
        const time = formatCandleTimestamp(candle.startTime);
        return `${time} UTC O${formatCandlePrice(candle.open)} H${formatCandlePrice(
            candle.high
        )} L${formatCandlePrice(candle.low)} C${formatCandlePrice(
            candle.close
        )} V${formatBigNumber(candle.volume)}`;
    });

    return `${label} (latest ${entries.length}):\n  ${entries.join("\n  ")}`;
}

function sortCandlesChronologically(candles = []) {
    return candles
        .slice()
        .filter((candle) => Number.isFinite(candle.startTime))
        .sort((a, b) => a.startTime - b.startTime);
}

function calculateVWMA(candles = [], length = 20) {
    const sorted = sortCandlesChronologically(candles);
    if (sorted.length < length) {
        return null;
    }
    const recent = sorted.slice(-length);
    let volumeSum = 0;
    let weightedSum = 0;
    for (const candle of recent) {
        const vol = Number(candle.volume) || 0;
        const close = Number(candle.close) || 0;
        volumeSum += vol;
        weightedSum += close * vol;
    }
    if (volumeSum <= 0) {
        return null;
    }
    return weightedSum / volumeSum;
}

function calculateRSI(candles = [], period = 14) {
    const sorted = sortCandlesChronologically(candles);
    if (sorted.length < period + 1) {
        return null;
    }
    const closes = sorted.map((candle) => Number(candle.close) || 0);
    const slice = closes.slice(-(period + 1));
    let gains = 0;
    let losses = 0;
    for (let i = 1; i < slice.length; i++) {
        const delta = slice[i] - slice[i - 1];
        if (delta >= 0) {
            gains += delta;
        } else {
            losses += Math.abs(delta);
        }
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (!Number.isFinite(avgGain) || !Number.isFinite(avgLoss)) {
        return null;
    }
    if (avgLoss === 0) {
        return 100;
    }
    if (avgGain === 0) {
        return 0;
    }
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
}

function buildEmaSeries(values = [], period) {
    if (!Array.isArray(values) || values.length < period) {
        return [];
    }
    const result = new Array(values.length).fill(null);
    const initialSlice = values.slice(0, period);
    if (initialSlice.some((value) => !Number.isFinite(value))) {
        return [];
    }
    let ema =
        initialSlice.reduce((sum, value) => sum + value, 0) / period;
    result[period - 1] = ema;
    const multiplier = 2 / (period + 1);
    for (let i = period; i < values.length; i++) {
        const value = values[i];
        if (!Number.isFinite(value)) {
            result[i] = result[i - 1];
            continue;
        }
        ema = (value - ema) * multiplier + ema;
        result[i] = ema;
    }
    return result;
}

function calculateMACD(candles = [], fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    const sorted = sortCandlesChronologically(candles);
    if (sorted.length < slowPeriod + signalPeriod) {
        return null;
    }
    const closes = sorted.map((candle) => Number(candle.close) || 0);
    const emaFastSeries = buildEmaSeries(closes, fastPeriod);
    const emaSlowSeries = buildEmaSeries(closes, slowPeriod);
    if (!emaFastSeries.length || !emaSlowSeries.length) {
        return null;
    }
    const macdSeries = closes
        .map((_, index) => {
            const fast = emaFastSeries[index];
            const slow = emaSlowSeries[index];
            return Number.isFinite(fast) && Number.isFinite(slow)
                ? fast - slow
                : null;
        })
        .filter((value) => Number.isFinite(value));
    if (macdSeries.length < signalPeriod) {
        return null;
    }
    const macdLine = macdSeries[macdSeries.length - 1];
    const signalSeries = buildEmaSeries(macdSeries, signalPeriod);
    if (!signalSeries.length) {
        return null;
    }
    const signalLine = signalSeries[signalSeries.length - 1];
    if (!Number.isFinite(macdLine) || !Number.isFinite(signalLine)) {
        return null;
    }
    return {
        line: macdLine,
        signal: signalLine,
        histogram: macdLine - signalLine
    };
}

function calculateIndicatorSuite(candles = []) {
    if (!Array.isArray(candles) || candles.length === 0) {
        return null;
    }
    const vwma20 = calculateVWMA(candles, 20);
    const rsi14 = calculateRSI(candles, 14);
    const macd = calculateMACD(candles, 12, 26, 9);
    if (
        !Number.isFinite(vwma20) &&
        !Number.isFinite(rsi14) &&
        (!macd || !Number.isFinite(macd.line))
    ) {
        return null;
    }
    return {
        vwma20,
        rsi14,
        macdLine: macd?.line ?? null,
        macdSignal: macd?.signal ?? null,
        macdHistogram: macd?.histogram ?? null
    };
}

function formatIndicatorValue(value, decimals = 2) {
    return Number.isFinite(value) ? value.toFixed(decimals) : "n/a";
}

function buildIndicatorSummary(seriesMap = {}) {
    const orderedLabels = ["1m", "5m", "1h"];
    const lines = orderedLabels.map((label) => {
        const metrics = calculateIndicatorSuite(seriesMap[label]);
        if (!metrics) {
            return `${label}: VWMA20 n/a, RSI14 n/a | MACD n/a/n/a/n/a`;
        }
        const vwmaText = Number.isFinite(metrics.vwma20)
            ? `$${formatUsd(metrics.vwma20)}`
            : "n/a";
        const rsiText = Number.isFinite(metrics.rsi14)
            ? formatIndicatorValue(metrics.rsi14, 1)
            : "n/a";
        const macdLine = formatIndicatorValue(metrics.macdLine, 2);
        const macdSignal = formatIndicatorValue(metrics.macdSignal, 2);
        const macdHistogram = formatIndicatorValue(metrics.macdHistogram, 2);
        return `${label}: VWMA20 ${vwmaText}, RSI14 ${rsiText} | MACD ${macdLine}/${macdSignal}/${macdHistogram}`;
    });

    return [
        "MACD values listed as line/signal/histogram:",
        ...lines
    ].join("\n");
}

function buildSamplingData(seriesMap = {}, market, position) {
    const orderedLabels = ["1m", "5m", "1h"];
    const sections = orderedLabels
        .map((label) => formatSeriesSection(label, seriesMap[label]))
        .filter(Boolean);

    if (!sections.length) {
        const price = market ? `$${formatUsd(market.price)}` : "unknown price";
        const positionNote = position
            ? `${position.side} ${position.size.toFixed(4)} contracts live`
            : "Flat stance maintained";
        sections.push(`No intraday candles available. Latest price ${price}; ${positionNote}.`);
    }

    return sections.join("\n");
}

function calculateMarginUsage(account) {
    const denominator = account.totalEquity || 1;
    return (account.usedMargin || 0) / denominator;
}

function buildTemplateData(context) {
    const runtimeMinutes = Math.max(
        1,
        Math.round((Date.now() - SESSION_START) / 60000)
    );
    const market = context.market[BYBIT_SYMBOL];
    if (!market) {
        throw new Error("Market data for BTCUSDT missing from context.");
    }
    const marginUsageRatio = calculateMarginUsage(context.account);

    return {
        runtime_minutes: runtimeMinutes,
        current_time_utc: new Date().toISOString(),
        real_trading_warning: "REAL CAPITAL DEPLOYMENT - confirm entries before transmitting orders.",
        total_equity: formatUsd(context.account.totalEquity),
        available_balance: formatUsd(context.account.availableBalance),
        used_margin: formatUsd(context.account.usedMargin),
        margin_usage_percent: formatPercent(marginUsageRatio),
        margin_usage_ratio: marginUsageRatio.toFixed(4),
        maintenance_margin: formatUsd(context.account.maintenanceMargin),
        max_leverage: TARGET_LEVERAGE,
        default_leverage: TARGET_LEVERAGE,
        positions_detail: context.positionDetail,
        selected_symbols_count: 1,
        selected_symbols_detail: `- BTCUSDT: $${formatUsd(market.price)} | 24h ${market.change24h >= 0 ? "+" : ""
            }${market.change24h.toFixed(2)}% | funding ${market.fundingRate}`,
        selected_symbols_csv: BYBIT_SYMBOL,
        market_prices: `BTCUSDT: $${formatUsd(market.price)} (${market.change24h >= 0 ? "+" : ""}${market.change24h.toFixed(
            2
        )}% 24h | funding ${market.fundingRate} | vol ${formatBigNumber(
            market.volume24h
        )} USDT)`,
        sampling_data: context.samplingData,
        indicator_section:
            context.indicatorSummary ||
            "Indicator data unavailable for VWMA20/RSI14/MACD.",
        news_section:
            context.newsHeadline ||
            "Spot BTC ETF inflows remain positive; no major macro catalysts scheduled during this session.",
        output_format: createOutputFormatDescriptor()
    };
}

function parseModelDecisions(rawContent) {
    try {
        return JSON.parse(rawContent);
    } catch (error) {
        console.error("Failed to parse model output", rawContent);
        throw error;
    }
}

function resolveCloseSide(position) {
    const heldSide = position?.side?.toUpperCase();
    if (heldSide === "SELL") {
        return "Buy";
    }
    return "Sell";
}

function resolvePositionIdx(normalizedOperation, side, position, positionMode) {
    if ((positionMode || "").toUpperCase() !== "HEDGE") {
        return undefined;
    }
    if (normalizedOperation === "close" && position) {
        return position.side?.toUpperCase() === "SELL" ? 2 : 1;
    }
    return side === "Buy" ? 1 : 2;
}

function mapDecisionsToBybitOrders(decisions, context) {
    const market = context.market[BYBIT_SYMBOL];
    const marginBase = context.account.availableBalance;
    const position = context.position;
    const positionMode = context.positionMode;
    const instrumentMeta = context.instrumentMeta || {};
    const qtyStep = instrumentMeta.qtyStep || DEFAULT_QTY_STEP;
    const minOrderQty = instrumentMeta.minOrderQty || qtyStep;
    const maxOrderQty = instrumentMeta.maxOrderQty || Infinity;
    const tickSize = instrumentMeta.tickSize || DEFAULT_TICK_SIZE;

    return decisions
        .filter(
            (decision) =>
                decision &&
                decision.operation &&
                decision.operation.toLowerCase() !== "hold" &&
                Number(decision.target_portion_of_balance) > 0
        )
        .map((decision, index) => {
            const normalizedOperation = (decision.operation || "").toLowerCase();
            const portion = Math.max(0, Number(decision.target_portion_of_balance ?? 0));

            if (normalizedOperation === "close" && (!position || !Number(position.size))) {
                return null;
            }

            const requestedLeverage = Math.round(
                Number(decision.leverage ?? TARGET_LEVERAGE)
            );
            const side =
                normalizedOperation === "buy"
                    ? "Buy"
                    : normalizedOperation === "close"
                        ? resolveCloseSide(position)
                        : "Sell";
            const positionIdx = resolvePositionIdx(
                normalizedOperation,
                side,
                position,
                positionMode
            );
            const requiresMaxPrice = side === "Buy";
            const priceCandidate = Number(
                requiresMaxPrice ? decision.max_price : decision.min_price
            );
            const orderPrice =
                Number.isFinite(priceCandidate) && priceCandidate > 0
                    ? priceCandidate
                    : market.price;
            const price = quantizeToStep(orderPrice, tickSize, "round");
            if (
                !Number.isFinite(price) ||
                price <= 0 ||
                (instrumentMeta.minPrice && price < instrumentMeta.minPrice) ||
                (instrumentMeta.maxPrice && price > instrumentMeta.maxPrice)
            ) {
                return null;
            }

            const baseLeverage =
                Number.isFinite(requestedLeverage) && requestedLeverage >= 1
                    ? Math.min(requestedLeverage, TARGET_LEVERAGE)
                    : TARGET_LEVERAGE;
            const leverage =
                normalizedOperation === "close" && Number.isFinite(Number(position?.leverage))
                    ? Math.max(1, Math.round(Number(position.leverage)))
                    : baseLeverage;

            const needsProtection = normalizedOperation !== "close";
            const stopLossInput = Number(decision.stop_loss_price);
            const takeProfitInput = Number(decision.take_profit_price);
            const stopLossPrice =
                needsProtection && Number.isFinite(stopLossInput) && stopLossInput > 0
                    ? quantizeToStep(stopLossInput, tickSize, "round")
                    : null;
            const takeProfitPrice =
                needsProtection && Number.isFinite(takeProfitInput) && takeProfitInput > 0
                    ? quantizeToStep(takeProfitInput, tickSize, "round")
                    : null;

            if (needsProtection && (!stopLossPrice || !takeProfitPrice)) {
                console.warn(
                    "Skipping decision missing stop loss or take profit",
                    decision
                );
                return null;
            }

            if (needsProtection) {
                if (
                    (side === "Buy" && !(stopLossPrice < price && takeProfitPrice > price)) ||
                    (side === "Sell" && !(stopLossPrice > price && takeProfitPrice < price))
                ) {
                    console.warn(
                        "Skipping decision with inconsistent TP/SL relative to entry",
                        decision
                    );
                    return null;
                }
            }

            let rawQty = 0;
            if (normalizedOperation === "close") {
                const liveSize = Number(position?.size);
                if (!Number.isFinite(liveSize) || liveSize <= 0) {
                    return null;
                }
                const closeFraction = portion > 0 ? Math.min(portion, 1) : 1;
                rawQty = liveSize * closeFraction;
            } else {
                const marginAllocation = marginBase * portion;
                if (!Number.isFinite(marginAllocation) || marginAllocation <= 0) {
                    return null;
                }
                const minMarginRequirement = (minOrderQty * price) / leverage;
                const notional = marginAllocation * leverage;
                const allocationQty = notional / price;
                if (allocationQty >= minOrderQty) {
                    rawQty = allocationQty;
                } else if (marginBase >= minMarginRequirement) {
                    rawQty = minOrderQty;
                } else {
                    console.warn(
                        "Skipping decision; insufficient margin to meet Bybit min order size",
                        JSON.stringify({
                            symbol: decision.symbol || BYBIT_SYMBOL,
                            operation: decision.operation,
                            availableBalance: marginBase,
                            requiredMargin: minMarginRequirement
                        })
                    );
                    return null;
                }
            }

            const qty = quantizeToStep(rawQty, qtyStep, "floor");
            if (
                !Number.isFinite(qty) ||
                qty <= 0 ||
                qty < minOrderQty ||
                qty > maxOrderQty
            ) {
                console.warn(
                    "Skipping decision due to quantity constraints",
                    JSON.stringify({
                        symbol: decision.symbol || BYBIT_SYMBOL,
                        operation: decision.operation,
                        portion,
                        rawQty,
                        qty,
                        minOrderQty,
                        maxOrderQty
                    })
                );
                return null;
            }

            return {
                category: BYBIT_CATEGORY,
                symbol: decision.symbol || BYBIT_SYMBOL,
                side,
                orderType: "Limit",
                qty,
                price,
                timeInForce: "GTC",
                reduceOnly: normalizedOperation === "close",
                leverage,
                positionIdx,
                orderLinkId: `codex-btcusdt-${Date.now()}-${index}`,
                stopLoss: needsProtection ? stopLossPrice : undefined,
                takeProfit: needsProtection ? takeProfitPrice : undefined,
                slTriggerBy: needsProtection ? "LastPrice" : undefined,
                tpTriggerBy: needsProtection ? "LastPrice" : undefined,
                reason: decision.reason,
                trading_strategy: decision.trading_strategy
            };
        })
        .filter(Boolean);
}

function shouldSkipTelegramNotification(decisions = []) {
    if (!Array.isArray(decisions) || decisions.length === 0) {
        return false;
    }
    return decisions.every(
        (decision) => (decision.operation || "").toLowerCase() === "hold"
    );
}

async function placeOrdersOnBybit(orders = []) {
    const executions = [];
    for (const order of orders) {
        try {
            if (!order.reduceOnly) {
                await ensureSymbolLeverage(order.symbol, order.leverage, order.category);
            }
            const body = {
                category: order.category,
                symbol: order.symbol,
                side: order.side,
                orderType: order.orderType,
                qty: order.qty.toString(),
                price: order.price.toString(),
                timeInForce: order.timeInForce,
                reduceOnly: order.reduceOnly,
                orderLinkId: order.orderLinkId
            };

            if (typeof order.positionIdx === "number") {
                body.positionIdx = order.positionIdx;
            }

            if (Number.isFinite(order.takeProfit) && order.takeProfit > 0) {
                body.takeProfit = order.takeProfit.toString();
                body.tpTriggerBy = order.tpTriggerBy || "LastPrice";
            }

            if (Number.isFinite(order.stopLoss) && order.stopLoss > 0) {
                body.stopLoss = order.stopLoss.toString();
                body.slTriggerBy = order.slTriggerBy || "LastPrice";
            }

            const result = await bybitRequest({
                path: "/v5/order/create",
                method: "POST",
                body,
                auth: true
            });

            executions.push({
                status: "success",
                order,
                orderId: result.orderId ?? result.order?.orderId ?? result.orderLinkId,
                result
            });
        } catch (error) {
            executions.push({ status: "error", order, error: error.message });
        }
    }
    return executions;
}

function formatTelegramLog(
    decisions = [],
    instructions = [],
    executions = [],
    preOrderBalance
) {
    const decisionLines = decisions.map((decision) => {
        const pct = (Number(decision.target_portion_of_balance) * 100).toFixed(1);
        const leverage = decision.leverage ?? TARGET_LEVERAGE;
        const symbol = decision.symbol || BYBIT_SYMBOL;
        return `• ${symbol} → ${decision.operation.toUpperCase()} | ${pct}% bal | lev ${leverage}`;
    });

    const instructionLines = instructions.map((order) => {
        const slText =
            Number.isFinite(Number(order.stopLoss)) && Number(order.stopLoss) > 0
                ? `$${formatUsd(order.stopLoss)}`
                : "n/a";
        const tpText =
            Number.isFinite(Number(order.takeProfit)) && Number(order.takeProfit) > 0
                ? `$${formatUsd(order.takeProfit)}`
                : "n/a";
        return `• ${order.symbol} ${order.side} ${order.qty} @ ${order.price} (${order.orderType}, lev ${order.leverage} | SL ${slText} | TP ${tpText})`;
    });

    const executionLines = executions.map((exec) => {
        if (exec.status === "success") {
            return `• ✅ ${exec.order.symbol} ${exec.order.side} ${exec.order.qty} @ ${exec.order.price} (orderId ${exec.orderId})`;
        }
        return `• ❌ ${exec.order.symbol} ${exec.order.side} ${exec.order.qty} @ ${exec.order.price} — ${exec.error}`;
    });

    const balanceLine =
        instructions.length && Number.isFinite(Number(preOrderBalance))
            ? `Available balance before new orders: $${formatUsd(preOrderBalance)} USDT`
            : null;

    const segments = [
        `Bybit ${BYBIT_SYMBOL} decisions @ ${new Date().toUTCString()}`,
        decisionLines.length ? decisionLines.join("\n") : "• HOLD (no actionable trades)",
        ""
    ];

    if (balanceLine) {
        segments.push(balanceLine, "");
    }

    segments.push(
        "Bybit API instructions:",
        instructionLines.length
            ? instructionLines.join("\n")
            : "• No orders generated; hold directive received."
    );

    if (executions.length) {
        segments.push("", "Execution status:", executionLines.join("\n"));
    }

    return segments
        .filter((segment) => segment !== null && segment !== undefined)
        .join("\n");
}

async function requestModelDecisions(prompt) {
    console.log("Prompt sent to model:\n", prompt);
    const completion = await openai.chat.completions.create({
        model: "qwen3-max",
        temperature: 0.2,
        messages: [
            {
                role: "system",
                content:
                    "You are a disciplined Bybit trading assistant. Respond with JSON only per the provided schema."
            },
            { role: "user", content: prompt }
        ]
    });

    const content = completion.choices?.[0]?.message?.content?.trim();

    if (!content) {
        throw new Error("Model returned empty response");
    }

    return parseModelDecisions(content);
}

async function executeTradingCycle() {
    const cycleStartedAt = Date.now();
    const [
        accountSnapshot,
        marketData,
        instrumentMeta,
        positionState,
        news,
        intradaySeries
    ] = await Promise.all([
        fetchUnifiedAccountSnapshot(),
        fetchBtcusdtTicker(),
        fetchBtcusdtInstrumentMeta(),
        fetchBtcusdtPositionState(),
        fetchLatestNewsSummary(),
        fetchIntradaySeries()
    ]);
    const { position, positionMode } = positionState;

    const context = {
        account: accountSnapshot,
        market: { [BYBIT_SYMBOL]: marketData },
        position,
        positionMode,
        instrumentMeta,
        positionDetail: describePosition(position),
        samplingData: buildSamplingData(intradaySeries, marketData, position),
        indicatorSummary: buildIndicatorSummary(intradaySeries),
        newsHeadline: news.summary
    };

    const hasProtectedPosition =
        position &&
        Number(position.size) > 0 &&
        Number(position.takeProfit) > 0 &&
        Number(position.stopLoss) > 0;

    if (hasProtectedPosition) {
        console.log(
            "Existing BTCUSDT position already has TP/SL set; skipping new instructions this cycle."
        );
        return;
    }

    const templateParams = buildTemplateData(context);
    const prompt = fillTemplate(bybit_template, templateParams);

    const decisionPayload = await requestModelDecisions(prompt);
    const decisions = decisionPayload.decisions ?? [];
    const orderInstructions = mapDecisionsToBybitOrders(decisions, context);

    let executionResults = [];
    if (orderInstructions.length) {
        executionResults = await placeOrdersOnBybit(orderInstructions);
    }

    const telegramMessage = formatTelegramLog(
        decisions,
        orderInstructions,
        executionResults,
        context.account?.availableBalance
    );

    console.log("Model decisions:", JSON.stringify(decisionPayload, null, 2));
    console.log("Bybit order instructions:", orderInstructions);
    console.log("Execution results:", executionResults);
    if (shouldSkipTelegramNotification(decisions)) {
        console.log("All decisions are HOLD; skipping Telegram notification.");
    } else {
        await sendTelegramNotification(telegramMessage);
    }
    const durationMs = Date.now() - cycleStartedAt;
    console.log(`Cycle completed in ${durationMs}ms`);
}

async function sendTelegramNotification(message) {
    try {
        await bot.sendMessage(TELEGRAM_CHAT_ID, message);
    } catch (error) {
        console.error("Failed to send Telegram message:", error);
    }
}

async function reportCycleError(error) {
    console.error("Trading cycle failed:", error);
    try {
        await bot.sendMessage(
            TELEGRAM_CHAT_ID,
            `Trading script error: ${error.message}`
        );
    } catch (sendError) {
        console.error("Failed to notify Telegram about error:", sendError);
    }
}

let cycleTimer = null;
let isCycleRunning = false;
let shuttingDown = false;

async function runScheduledCycle() {
    if (shuttingDown) {
        return;
    }

    if (isCycleRunning) {
        console.warn("Previous trading cycle still running; skipping this tick.");
        return;
    }

    isCycleRunning = true;
    try {
        await executeTradingCycle();
    } catch (error) {
        await reportCycleError(error);
    } finally {
        isCycleRunning = false;
        scheduleNextCycle();
    }
}

function scheduleNextCycle() {
    if (shuttingDown) {
        return;
    }
    clearTimeout(cycleTimer);
    cycleTimer = setTimeout(runScheduledCycle, EXECUTION_INTERVAL_MS);
}

function startScheduler() {
    console.log(
        `Starting trading loop; interval set to ${Math.round(
            EXECUTION_INTERVAL_MS / 1000
        )} seconds`
    );
    runScheduledCycle();
}

async function shutdown(signal) {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    console.log(`Received ${signal}; stopping scheduler...`);
    clearTimeout(cycleTimer);

    if (!isCycleRunning) {
        process.exit(0);
        return;
    }

    const waitForCycle = setInterval(() => {
        if (!isCycleRunning) {
            clearInterval(waitForCycle);
            process.exit(0);
        }
    }, 500);
}

process.on("SIGINT", () => {
    shutdown("SIGINT");
});

process.on("SIGTERM", () => {
    shutdown("SIGTERM");
});

startScheduler();
