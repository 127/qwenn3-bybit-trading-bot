// # Bybit-specific prompt template for perpetual contract trading
export const bybit_template = `=== SESSION CONTEXT ===
Runtime: {runtime_minutes} minutes since trading started
Current UTC time: {current_time_utc}

=== TRADING ENVIRONMENT ===
Platform: Bybit Perpetual Contracts
Environment: MAINNET
⚠️ {real_trading_warning}

=== ACCOUNT STATE ===
Total Equity (USDC): \${total_equity}
Available Balance: \${available_balance}
Used Margin: \${used_margin}
Margin Usage: {margin_usage_percent}%
Maintenance Margin: \${maintenance_margin}

Account Leverage Settings:
- Maximum Leverage: {max_leverage}x
- Default Leverage: {default_leverage}x
- Current positions can use up to {max_leverage}x leverage

=== OPEN POSITIONS ===
{positions_detail}

=== SYMBOLS IN PLAY ===
Monitoring {selected_symbols_count} Bybit contracts (multi-coin decisioning is the default):
{selected_symbols_detail}

=== MARKET DATA ===
Current prices (USD):
{market_prices}

=== INTRADAY PRICE SERIES ===
{sampling_data}

=== TECHNICAL INDICATORS ===
VWMA20, RSI14, and MACD(12/26/9) computed for 1m, 5m, and 1h intervals (MACD reported as line/signal/histogram):
{indicator_section}

=== LATEST CRYPTO NEWS ===
{news_section}

=== PERPETUAL CONTRACT TRADING RULES ===
You are trading real perpetual contracts on Bybit. Key concepts:

**Leverage Trading:**
- Leverage multiplies both gains and losses
- Higher leverage = higher risk of liquidation
- Example: 10x leverage on $1000 position = $10,000 exposure
- Liquidation occurs when losses approach maintenance margin

**Position Management:**
- Long positions profit when price increases
- Short positions profit when price decreases
- Unrealized PnL changes with market price
- Positions incur funding fees (typically small)

**Risk Management (CRITICAL):**
- NEVER use maximum leverage without strong conviction
- Recommended default: 2-3x for most trades
- Higher leverage (5-10x) only for high-probability setups
- Always consider liquidation price relative to support/resistance
- Monitor margin usage - keep below 70% to avoid forced liquidation

**Action Mandate (IMPORTANT):**
- Current margin usage is {margin_usage_percent} (ratio {margin_usage_ratio}, i.e., margin_usage_percent / 100).
- When {margin_usage_ratio} < 0.70 and no conflicting position exists, HOLD-only output is prohibited. Deploy at least one probing trade sized between 0.05 and 0.20 of available balance with clear invalidation.
- HOLD-only output is acceptable only when {margin_usage_ratio} ≥ 0.70 or when you are managing an existing position with explicit exit instructions.
- If conviction is low, choose the smaller allocation but still provide a directional plan and stop/target detail.

**Liquidation Risk:**
- Your position will be forcibly closed if price hits liquidation level
- Liquidation price moves closer to entry price as leverage increases
- Example: 10x long on BTC at $50,000 → liquidation ~$45,000
- Always factor in volatility when choosing leverage

**Decision Framework:**
1. Analyze market conditions and volatility
2. Choose leverage based on confidence level and volatility
3. Calculate potential liquidation price before entering
4. Ensure adequate margin buffer (30%+ free margin)
5. Set clear profit targets and stop loss levels

=== DECISION REQUIREMENTS ===
- You must analyze every coin listed above and return decisions for each relevant opportunity (multi-coin output is required every cycle).
- If a coin has no actionable setup, keep it in the decisions array with \`operation: "hold"\` and \`target_portion_of_balance: 0\` to document the assessment.
- Choose operation: "buy" (long), "sell" (short), "hold", or "close"
- For "buy" (long): target_portion_of_balance is % of available balance to use (0.0-1.0)
- For "sell" (short): target_portion_of_balance is % of available balance to use (0.0-1.0)
- For "close": target_portion_of_balance is % of position to close (0.0-1.0, typically 1.0) and you must include the same price guardrail you would use if initiating that directional action (see below).
- For "hold": target_portion_of_balance must be 0
- leverage: integer 1-{max_leverage} (lower = safer, higher = more risk)
- Every non-HOLD entry must include explicit \`stop_loss_price\` (where the trade is invalidated) and \`take_profit_price\` (first target); omit both only when operation is "hold".
- Price guardrails:
  - Provide \`max_price\` whenever the execution requires buying (operations "buy" plus any \`close\` that covers a short).
  - Provide \`min_price\` whenever the execution requires selling (operations "sell" plus any \`close\` that reduces a long).
  - \`hold\` entries must omit both \`max_price\` and \`min_price\`.
- HOLD-only decision sets are invalid when {margin_usage_ratio} < 0.70 and available balance is positive; you must return at least one buy/sell/close instruction in those cases.
- Never trade symbols not in the market data
- Provide comprehensive reasoning for every decision (especially how each coin fits into the multi-coin allocation and its leverage/risk trade-offs).
- Estimate projected margin usage before finalizing: \`projected_ratio ~= {margin_usage_ratio} + (available_balance / total_equity) * sum(target_portion_of_balance * leverage)\` and keep \`projected_ratio < 0.70\`. Example - if available_balance = 20,000, total_equity = 40,000, and you plan two trades (0.10*3 + 0.05*2 = 0.40), the added ratio ~= 0.50 * 0.40 = 0.20, so only proceed if current ratio <= 0.50.
- Consider that available balance and cross margin are shared across every position you open or extend; size positions holistically.
- Execution order is critical for Bybit real trades: (1) close positions to free margin, (2) open/extend SELL entries, (3) open/extend BUY entries.

=== OUTPUT FORMAT ===
Respond with ONLY a JSON object using this schema (always emitting the \`decisions\` array even if it is empty):
{output_format}

CRITICAL OUTPUT REQUIREMENTS:
- Output MUST be a single, valid JSON object only
- NO markdown code blocks (no \`\`\`json\`\`\` wrappers)
- NO explanatory text before or after the JSON
- NO comments or additional content outside the JSON object
- Ensure all JSON fields are properly quoted and formatted
- Double-check JSON syntax before responding

Example output with multiple simultaneous orders (use plain single braces exactly as shown in your final JSON):
{
  "decisions": [
    {
      "operation": "buy",
  "symbol": "BTC",
  "target_portion_of_balance": 0.3,
  "leverage": 3,
  "max_price": 49500,
  "stop_loss_price": 47500,
  "take_profit_price": 52000,
  "reason": "Strong bullish momentum with support holding at $48k, RSI recovering from oversold",
  "trading_strategy": "Opening 3x leveraged long position with 30% balance. Stop below $47.5k swing low, target retest of $52k resistance. Max price keeps slippage within 3%."
},
{
  "operation": "sell",
  "symbol": "ETH",
  "target_portion_of_balance": 0.2,
  "leverage": 2,
  "min_price": 3125,
  "stop_loss_price": 3250,
  "take_profit_price": 2980,
  "reason": "ETH perp funding flipped elevated negative while momentum weakens",
  "trading_strategy": "Initiating small short hedge until ETH regains strength vs BTC pair. Stop if ETH closes back above $3.2k structural pivot."
}
  ]
}

FIELD TYPE REQUIREMENTS:
- decisions: array (one entry per supported symbol; include HOLD entries with zero allocation when you choose not to act)
- operation: string ("buy" for long, "sell" for short, "hold", or "close")
- symbol: string (must match one of: {selected_symbols_csv})
- target_portion_of_balance: number (float between 0.0 and 1.0)
- leverage: integer (between 1 and {max_leverage}, REQUIRED field)
- max_price: number (required whenever the instruction buys contracts - opening longs or covering shorts - and caps acceptable fill price)
- min_price: number (required whenever the instruction sells contracts - opening shorts or reducing longs - and sets the lowest acceptable fill)
- stop_loss_price: number (required for every buy/sell/close and must reflect the invalidation level; omit for holds)
- take_profit_price: number (required for every buy/sell/close and must reflect the first target; omit for holds)
- reason: string explaining the key catalyst, risk, or signal (no strict length limit, but stay focused)
- trading_strategy: string covering entry thesis, leverage reasoning, liquidation awareness, and exit plan
`;
