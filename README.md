# tradingview-bridge-mcp

MCP server that connects AI agents to TradingView via Chrome DevTools Protocol (CDP). Launch the browser, read chart data, change symbols/timeframes, and run JavaScript inside TradingView — all through natural language.

Works with **any MCP-compatible AI agent** — Claude Code, Codex CLI, Gemini CLI, Cursor, Windsurf, or any tool that supports the [Model Context Protocol](https://modelcontextprotocol.io/).

## Tools

| Tool | Description |
|------|-------------|
| `launch_browser` | Launch Chrome (or TradingView Desktop) with CDP debug port and open TradingView |
| `health_check` | Verify CDP connection and TradingView tab status |
| `get_chart_state` | Read symbol, timeframe, OHLCV, and last price from the active chart |
| `navigate` | Change chart symbol and/or timeframe |
| `draw_lines` | Draw horizontal support/resistance lines at specified price levels |
| `draw_trendline` | Draw a trendline between two time+price points |
| `draw_rectangle` | Draw a rectangle zone (supply/demand, consolidation areas) |
| `remove_drawings` | Remove all drawings or specific ones by ID |
| `evaluate` | Run arbitrary JavaScript inside the TradingView page |

## Prerequisites

Complete these steps before using the MCP server:

### 1. Install Node.js

Download and install Node.js 18+ from [nodejs.org](https://nodejs.org/).

### 2. Install Google Chrome

Download from [google.com/chrome](https://www.google.com/chrome/). Already installed on most Windows machines.

### 3. TradingView account

Sign up at [tradingview.com](https://www.tradingview.com/). Works with the free plan.

> **Note:** The first time Chrome opens via this MCP, it uses a separate profile. You'll need to log into TradingView once in that browser window.

## Quick Start

Once the prerequisites are done, open your AI agent and paste one of these prompts:

### Install & setup

```
Clone and install the MCP server from https://github.com/pornthepp/tradingview-bridge-mcp.git,
then register it as an MCP server named "tradingview-bridge" using stdio transport.
```

### Read chart data

```
Launch TradingView via the bridge, then read the chart state
and tell me the current symbol, timeframe, and price data.
```

### Navigate and analyze

```
Open TradingView, navigate to BTCUSD on the daily timeframe,
and describe what you see on the chart.
```

### Draw support/resistance

```
Draw horizontal support lines at 59000 and 60000 (green),
and resistance lines at 64000 and 65000 (orange) on my chart.
```

### Draw zones and trendlines

```
Mark the supply zone between 71000-74000 as a red rectangle,
and draw a trendline from the recent swing low to the current price.
```

### Advanced: run JavaScript

```
Use the evaluate tool to list all visible indicators on my TradingView chart.
```

## MCP Config (manual)

If your agent doesn't support auto-setup, add this to your MCP config file:

```json
{
  "mcpServers": {
    "tradingview-bridge": {
      "command": "node",
      "args": ["/full/path/to/tradingview-bridge-mcp/src/index.js"]
    }
  }
}
```

## Optional: TradingView Desktop mode

If you prefer TradingView Desktop (MSIX) over Chrome, pass `mode: "desktop"` to `launch_browser`. This requires:

1. [TradingView Desktop](https://www.tradingview.com/desktop/) installed
2. **Developer Mode** enabled: Windows Settings > System > For developers

## How it works

```
AI Agent  ──MCP──▶  tradingview-bridge-mcp  ──CDP WebSocket──▶  Chrome + TradingView
                    (this server)                               (chart page)
```

1. `launch_browser` starts Chrome with `--remote-debugging-port=9222` and opens `tradingview.com/chart`
2. Tools connect to Chrome via CDP WebSocket to the TradingView tab
3. `get_chart_state` evaluates JavaScript inside the page to extract chart data
4. `navigate` changes symbol/timeframe via URL navigation
5. `evaluate` runs any JavaScript — interact with Pine Editor, Strategy Tester, DOM elements, etc.

## Limitations

- **`get_chart_state` reads only 1 candle** — it returns OHLCV from the chart legend, which shows data for the candle currently under the cursor, not full historical data.
- **No bulk historical data tool** — use `evaluate` to run JavaScript via TradingView's internal API (e.g. `TradingViewApi.activeChart().getSeries()`) to access loaded bar data if needed.
- **Drawing tools need timestamps** — `draw_trendline` and `draw_rectangle` require Unix timestamps (seconds) for point coordinates. Use `evaluate` to query visible range first if needed.
- **DOM-based reads may break** — OHLCV and last price are read from DOM elements. TradingView UI updates may change class names. Symbol and timeframe (parsed from page title) are stable.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Chrome not found | Install Google Chrome or set the full path |
| CDP port not responding | Wait a few seconds, run `health_check` |
| No TradingView tab | Open `tradingview.com/chart` in the Chrome window |
| Port 9222 in use | Use a different port: `launch_browser` with `port: 9223` |
| OHLCV not returned | Hover over a candle so the legend shows values, then retry |
| Desktop mode `0x800704C7` | Enable Developer Mode (see optional section above) |

## License

MIT
