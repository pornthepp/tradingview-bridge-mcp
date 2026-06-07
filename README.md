# tradingview-bridge-mcp

MCP server that launches TradingView Desktop (Windows) with Chrome DevTools Protocol (CDP) enabled, verifies the connection, and reads chart state.

Works with **any MCP-compatible AI agent** — Claude Code, Codex CLI, Gemini CLI, or any tool that supports the [Model Context Protocol](https://modelcontextprotocol.io/).

## Tools

| Tool | Description |
|------|-------------|
| `launch_tradingview` | Launch TradingView Desktop with `--remote-debugging-port=9222` |
| `health_check` | Verify CDP port is responding |
| `get_chart_state` | Read current chart URL, title, and tab info |

## Requirements

- Windows 10/11
- Node.js 18+
- [TradingView Desktop](https://www.tradingview.com/desktop/) installed
- **Developer Mode enabled** (see setup below)

## Setup

### 1. Enable Developer Mode (Windows)

Required for `Invoke-CommandInDesktopPackage` to work with MSIX apps.

1. Open **Windows Settings**
2. Go to **System > For developers**
3. Toggle **Developer Mode** to **On**
4. Confirm the UAC prompt

> Without Developer Mode, launching TradingView with CDP will fail with error `0x800704C7`.

### 2. Install TradingView Desktop

Download from [tradingview.com/desktop](https://www.tradingview.com/desktop/).

### 3. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/tradingview-bridge-mcp.git
cd tradingview-bridge-mcp
npm install
```

### 4. Add to your AI agent

#### Claude Code

```bash
claude mcp add tradingview-bridge -- node /full/path/to/tradingview-bridge-mcp/src/index.js
```

#### Codex CLI

Add to your MCP config file (`~/.codex/config.json` or project-level):

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

#### Gemini CLI

Add to your MCP settings file:

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

#### Generic MCP client (stdio transport)

This server uses **stdio transport**. Start it with:

```bash
node /full/path/to/tradingview-bridge-mcp/src/index.js
```

Then communicate via stdin/stdout using the [MCP protocol](https://modelcontextprotocol.io/).

## Usage

Once configured, ask your AI agent to:

1. **Launch TradingView** — calls `launch_tradingview` to start TradingView Desktop with CDP enabled
2. **Check connection** — calls `health_check` to verify CDP port is responding
3. **Read chart state** — calls `get_chart_state` to get the current chart URL, title, and tab info

## How it works

TradingView Desktop is an Electron (Chromium-based) app packaged as MSIX on Windows. Electron apps support the Chrome DevTools Protocol via the `--remote-debugging-port` flag.

Because MSIX apps run in a sandbox, they cannot be launched directly with custom flags. This MCP uses `Invoke-CommandInDesktopPackage` (a Windows PowerShell cmdlet) to inject the flag into the MSIX container — which requires Developer Mode.

Once CDP is active, the MCP reads chart state through the DevTools HTTP API (`/json` endpoint).

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `0x800704C7` error | Enable Developer Mode (see setup step 1) |
| TradingView not found | Install TradingView Desktop from [tradingview.com/desktop](https://www.tradingview.com/desktop/) |
| CDP port not responding | Wait 5-10 seconds, then run `health_check` again |
| Port 9222 in use | Pass a different port: `launch_tradingview` with `port: 9223` |

## License

MIT
