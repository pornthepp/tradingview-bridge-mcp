# tradingview-bridge-mcp

MCP server that launches TradingView Desktop (Windows) with Chrome DevTools Protocol (CDP) enabled, verifies the connection, and reads chart state.

Works with **any MCP-compatible AI agent** — Claude Code, Codex CLI, Gemini CLI, Cursor, Windsurf, or any tool that supports the [Model Context Protocol](https://modelcontextprotocol.io/).

## Tools

| Tool | Description |
|------|-------------|
| `launch_tradingview` | Launch TradingView Desktop with `--remote-debugging-port=9222` |
| `health_check` | Verify CDP port is responding |
| `get_chart_state` | Read symbol, timeframe, OHLCV, and price from the active chart |

## Prerequisites

Complete these steps before using the MCP server:

### 1. Install Node.js

Download and install Node.js 18+ from [nodejs.org](https://nodejs.org/).

### 2. Install TradingView Desktop

Download from [tradingview.com/desktop](https://www.tradingview.com/desktop/). Works with the free plan.

### 3. Enable Developer Mode (Windows)

This is required for launching MSIX apps with custom flags.

1. Open **Windows Settings**
2. Go to **System > For developers**
3. Toggle **Developer Mode** to **On**
4. Confirm the UAC prompt

> Without Developer Mode, launching TradingView with CDP will fail with error `0x800704C7`.

## Quick Start

Once the prerequisites above are done, open your AI agent and paste one of these prompts:

### Install & setup

```
Clone and install the MCP server from https://github.com/pornthepp/tradingview-bridge-mcp.git,
then register it as an MCP server named "tradingview-bridge" using stdio transport.
```

### Read chart data

```
Launch TradingView with CDP enabled, then read the chart state
and tell me the current symbol, timeframe, and price data.
```

That's it — your AI agent handles cloning, installing, configuring, and running the tools.

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

## How it works

TradingView Desktop is an Electron (Chromium-based) app packaged as MSIX on Windows. Electron apps support the Chrome DevTools Protocol via the `--remote-debugging-port` flag.

Because MSIX apps run in a sandbox, they cannot be launched directly with custom flags. This MCP uses `Invoke-CommandInDesktopPackage` (a Windows PowerShell cmdlet) to inject the flag into the MSIX container — which requires Developer Mode.

Once CDP is active, the MCP reads chart state through the DevTools HTTP API (`/json` endpoint).

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `0x800704C7` error | Enable Developer Mode (see prerequisites step 3) |
| TradingView not found | Install TradingView Desktop from [tradingview.com/desktop](https://www.tradingview.com/desktop/) |
| CDP port not responding | Wait 5-10 seconds, then run `health_check` again |
| Port 9222 in use | Pass a different port: `launch_tradingview` with `port: 9223` |

## License

MIT
