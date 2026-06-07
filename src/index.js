#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync, spawn } from "child_process";
import { existsSync } from "fs";
import http from "http";
import WebSocket from "ws";

const server = new McpServer({
  name: "tradingview-bridge",
  version: "1.1.0",
});

// --- Helper: find TradingView MSIX package ---
function findTradingViewPackage() {
  try {
    const result = execSync(
      `powershell -Command "Get-AppxPackage -Name 'TradingView*' | Select-Object -ExpandProperty PackageFamilyName"`,
      { encoding: "utf8", timeout: 10000 }
    ).trim();
    return result || null;
  } catch {
    return null;
  }
}

function findTradingViewExe() {
  try {
    const result = execSync(
      `powershell -Command "Get-AppxPackage -Name 'TradingView*' | Select-Object -ExpandProperty InstallLocation"`,
      { encoding: "utf8", timeout: 10000 }
    ).trim();
    if (result) {
      const exePath = `${result}\\TradingView.exe`;
      if (existsSync(exePath)) return exePath;
    }
  } catch {}

  try {
    const result = execSync(
      `powershell -Command "Get-ChildItem 'C:\\Program Files\\WindowsApps\\TradingView*' -Filter TradingView.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName"`,
      { encoding: "utf8", timeout: 15000 }
    ).trim();
    return result || null;
  } catch {
    return null;
  }
}

// --- Helper: check CDP port ---
function checkCDP(port = 9222) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve({ connected: true, info: json });
        } catch {
          resolve({ connected: false });
        }
      });
    });
    req.on("error", () => resolve({ connected: false }));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve({ connected: false });
    });
  });
}

// --- Helper: find TradingView tab ---
function findTVTab(port = 9222) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const tabs = JSON.parse(data);
          const tvTab = tabs.find(
            (t) => t.url && t.url.includes("tradingview.com")
          );
          resolve(tvTab || null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

// --- Helper: evaluate JavaScript in a tab via CDP WebSocket ---
function cdpEvaluate(wsUrl, expression, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("CDP WebSocket timed out"));
    }, timeout);

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true },
        })
      );
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.id === 1) {
          clearTimeout(timer);
          ws.close();
          if (msg.result?.exceptionDetails) {
            reject(new Error(msg.result.exceptionDetails.text || "JS error"));
          } else {
            resolve(msg.result?.result?.value);
          }
        }
      } catch (e) {
        clearTimeout(timer);
        ws.close();
        reject(e);
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// JavaScript to extract chart data from TradingView page
const CHART_EXTRACT_JS = `
(function() {
  var r = {};

  // 1) Parse document.title — format: "SYMBOL, TIMEFRAME — TradingView"
  var parts = document.title.split(/\\s*[—–]\\s*TradingView/);
  if (parts[0]) {
    var commaIdx = parts[0].lastIndexOf(',');
    if (commaIdx !== -1) {
      r.symbol = parts[0].substring(0, commaIdx).trim();
      r.timeframe = parts[0].substring(commaIdx + 1).trim();
    } else {
      r.symbol = parts[0].trim();
    }
  }

  // 2) URL and chart ID
  r.url = location.href;
  var m = location.href.match(/chart\\/([^/?#]+)/);
  if (m) r.chartId = m[1];

  // 3) Try to read OHLCV from chart legend (best-effort, may fail on TV updates)
  try {
    var items = document.querySelectorAll('[data-name="legend-source-item"]');
    if (items.length > 0) {
      var vals = items[0].querySelectorAll('[class*="valueValue"]');
      var nums = [];
      vals.forEach(function(v) {
        var t = v.textContent.trim();
        if (t) nums.push(t);
      });
      if (nums.length >= 5) {
        r.open = nums[0];
        r.high = nums[1];
        r.low = nums[2];
        r.close = nums[3];
        r.volume = nums[4];
      }
    }
  } catch(e) {}

  // 4) Try to read last price
  try {
    var priceAxis = document.querySelector('[class*="lastPrice"]');
    if (priceAxis) r.lastPrice = priceAxis.textContent.trim();
  } catch(e) {}

  return JSON.stringify(r);
})()
`;

// --- Tool 1: launch_tradingview ---
server.tool(
  "launch_tradingview",
  "Launch TradingView Desktop (Windows MSIX) with CDP debug port enabled. Required before using health_check or get_chart_state.",
  {
    port: z.number().default(9222).describe("CDP debug port (default: 9222)"),
    wait_seconds: z
      .number()
      .default(5)
      .describe("Seconds to wait for TradingView to start"),
  },
  async ({ port, wait_seconds }) => {
    const already = await checkCDP(port);
    if (already.connected) {
      return {
        content: [
          {
            type: "text",
            text: `TradingView is already running with CDP on port ${port}. No need to relaunch.\n\nBrowser: ${already.info?.Browser || "unknown"}`,
          },
        ],
      };
    }

    const packageFamily = findTradingViewPackage();
    const exePath = findTradingViewExe();

    if (!packageFamily || !exePath) {
      return {
        content: [
          {
            type: "text",
            text: `TradingView Desktop (MSIX) not found.\n\nInstall from: https://www.tradingview.com/desktop/\nThen enable Developer Mode: Windows Settings > System > For developers`,
          },
        ],
        isError: true,
      };
    }

    const psCommand = `Invoke-CommandInDesktopPackage -PackageFamilyName '${packageFamily}' -AppId 'TradingView.Desktop' -Command '${exePath}' -Args '--remote-debugging-port=${port}'`;

    try {
      spawn("powershell", ["-Command", psCommand], {
        detached: true,
        stdio: "ignore",
        shell: true,
      }).unref();

      await new Promise((r) => setTimeout(r, wait_seconds * 1000));

      const check = await checkCDP(port);
      if (check.connected) {
        return {
          content: [
            {
              type: "text",
              text: `TradingView launched successfully.\n\nCDP port: ${port}\nBrowser: ${check.info?.Browser || "unknown"}\n\nReady for health_check and get_chart_state.`,
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: `TradingView launch command sent, but CDP port ${port} is not responding yet.\n\nTry:\n1. Wait a few seconds and run health_check\n2. Ensure Developer Mode is enabled: Windows Settings > System > For developers\n3. Ensure no other TradingView instance is running`,
            },
          ],
        };
      }
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to launch TradingView.\n\nError: ${err.message}\n\nRequirements:\n1. Developer Mode ON (Windows Settings > System > For developers)\n2. TradingView Desktop installed from tradingview.com/desktop`,
          },
        ],
        isError: true,
      };
    }
  }
);

// --- Tool 2: health_check ---
server.tool(
  "health_check",
  "Check if TradingView Desktop is running and CDP debug port is responding.",
  {
    port: z
      .number()
      .default(9222)
      .describe("CDP debug port to check (default: 9222)"),
  },
  async ({ port }) => {
    const result = await checkCDP(port);

    if (result.connected) {
      return {
        content: [
          {
            type: "text",
            text: `TradingView is connected.\n\nCDP port: ${port}\nBrowser: ${result.info?.Browser || "unknown"}\nProtocol: ${result.info?.["Protocol-Version"] || "unknown"}\n\nReady for get_chart_state.`,
          },
        ],
      };
    } else {
      return {
        content: [
          {
            type: "text",
            text: `TradingView is not connected on port ${port}.\n\nRun launch_tradingview first.`,
          },
        ],
        isError: true,
      };
    }
  }
);

// --- Tool 3: get_chart_state ---
server.tool(
  "get_chart_state",
  "Read the current TradingView chart data by evaluating JavaScript inside the page via CDP WebSocket. Returns symbol, timeframe, OHLCV (if visible in legend), last price, chart ID, and URL.",
  {
    port: z.number().default(9222).describe("CDP debug port (default: 9222)"),
  },
  async ({ port }) => {
    const cdp = await checkCDP(port);
    if (!cdp.connected) {
      return {
        content: [
          {
            type: "text",
            text: `TradingView is not connected. Run launch_tradingview first.`,
          },
        ],
        isError: true,
      };
    }

    const tab = await findTVTab(port);
    if (!tab || !tab.webSocketDebuggerUrl) {
      return {
        content: [
          {
            type: "text",
            text: `TradingView is running but no chart tab found.\n\nMake sure a chart is open in TradingView Desktop.`,
          },
        ],
      };
    }

    try {
      const raw = await cdpEvaluate(tab.webSocketDebuggerUrl, CHART_EXTRACT_JS);
      const data = JSON.parse(raw);

      let lines = [];
      if (data.symbol) lines.push(`Symbol: ${data.symbol}`);
      if (data.timeframe) lines.push(`Timeframe: ${data.timeframe}`);
      if (data.lastPrice) lines.push(`Last price: ${data.lastPrice}`);
      if (data.open) {
        lines.push(`Open: ${data.open}`);
        lines.push(`High: ${data.high}`);
        lines.push(`Low: ${data.low}`);
        lines.push(`Close: ${data.close}`);
      }
      if (data.volume) lines.push(`Volume: ${data.volume}`);
      if (data.chartId) lines.push(`Chart ID: ${data.chartId}`);
      if (data.url) lines.push(`URL: ${data.url}`);

      return {
        content: [
          {
            type: "text",
            text: lines.length > 0
              ? `Chart data:\n\n${lines.join("\n")}`
              : `Connected to TradingView tab but could not extract chart data.\n\nTitle: ${tab.title}\nURL: ${tab.url}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to read chart data via CDP WebSocket.\n\nError: ${err.message}\nTab: ${tab.url}\n\nThe tab was found but JavaScript evaluation failed.`,
          },
        ],
        isError: true,
      };
    }
  }
);

// --- Start server ---
const transport = new StdioServerTransport();
await server.connect(transport);
