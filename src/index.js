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
  version: "2.0.0",
});

// --- CDP Session: WebSocket wrapper for multi-command CDP communication ---
class CDPSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.msgId = 0;
    this.pending = new Map();
  }

  connect(timeout = 5000) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      const timer = setTimeout(() => {
        this.ws.close();
        reject(new Error("CDP connection timeout"));
      }, timeout);

      this.ws.on("open", () => {
        clearTimeout(timer);
        resolve();
      });

      this.ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const handler = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            clearTimeout(handler.timer);
            if (msg.error) handler.reject(new Error(msg.error.message));
            else handler.resolve(msg.result);
          }
        } catch {}
      });

      this.ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  send(method, params = {}, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const id = ++this.msgId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.text ||
          result.exceptionDetails.exception?.description ||
          "JS evaluation error"
      );
    }
    return result.result?.value;
  }

  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// --- Helper: find Google Chrome ---
function findChrome() {
  const paths = [
    process.env.PROGRAMFILES &&
      `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
    process.env["PROGRAMFILES(X86)"] &&
      `${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
    process.env.LOCALAPPDATA &&
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ].filter(Boolean);

  for (const p of paths) {
    if (existsSync(p)) return p;
  }

  try {
    const result = execSync(
      `powershell -Command "(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe' -ErrorAction SilentlyContinue).'(default)'"`,
      { encoding: "utf8", timeout: 5000 }
    ).trim();
    if (result && existsSync(result)) return result;
  } catch {}

  return null;
}

// --- Helper: find TradingView Desktop MSIX ---
function findTVDesktop() {
  try {
    const family = execSync(
      `powershell -Command "Get-AppxPackage -Name 'TradingView*' | Select-Object -ExpandProperty PackageFamilyName"`,
      { encoding: "utf8", timeout: 10000 }
    ).trim();
    const location = execSync(
      `powershell -Command "Get-AppxPackage -Name 'TradingView*' | Select-Object -ExpandProperty InstallLocation"`,
      { encoding: "utf8", timeout: 10000 }
    ).trim();
    if (family && location) {
      const exe = `${location}\\TradingView.exe`;
      if (existsSync(exe)) return { family, exe };
    }
  } catch {}
  return null;
}

// --- Helper: check CDP port ---
function checkCDP(port = 9222) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ connected: true, info: JSON.parse(data) });
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
          const tab = tabs.find(
            (t) => t.url && t.url.includes("tradingview.com")
          );
          resolve(tab || null);
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

// --- Helper: open CDP session to TradingView tab ---
async function openTVSession(port = 9222) {
  const tab = await findTVTab(port);
  if (!tab || !tab.webSocketDebuggerUrl) return null;
  const session = new CDPSession(tab.webSocketDebuggerUrl);
  await session.connect();
  return session;
}

// --- JS expressions for chart interaction ---
const JS_READ_CHART = `
(function() {
  var r = {};
  var parts = document.title.split(/\\s*[\\u2014\\u2013]\\s*TradingView/);
  if (parts[0]) {
    var ci = parts[0].lastIndexOf(',');
    if (ci !== -1) {
      r.symbol = parts[0].substring(0, ci).trim();
      r.timeframe = parts[0].substring(ci + 1).trim();
    } else {
      r.symbol = parts[0].trim();
    }
  }
  r.url = location.href;
  var m = location.href.match(/chart\\/([^/?#]+)/);
  if (m) r.chartId = m[1];
  try {
    var items = document.querySelectorAll('[data-name="legend-source-item"]');
    if (items.length > 0) {
      var vals = items[0].querySelectorAll('[class*="valueValue"]');
      var nums = [];
      vals.forEach(function(v) { var t = v.textContent.trim(); if (t) nums.push(t); });
      if (nums.length >= 5) { r.open = nums[0]; r.high = nums[1]; r.low = nums[2]; r.close = nums[3]; r.volume = nums[4]; }
      else if (nums.length >= 4) { r.open = nums[0]; r.high = nums[1]; r.low = nums[2]; r.close = nums[3]; }
    }
  } catch(e) {}
  try {
    var pe = document.querySelector('[class*="lastPrice"]');
    if (pe) r.lastPrice = pe.textContent.trim();
  } catch(e) {}
  return JSON.stringify(r);
})()
`;

// --- Tool 1: launch_browser ---
server.tool(
  "launch_browser",
  "Launch Google Chrome (or TradingView Desktop) with CDP debug port enabled and open TradingView chart page. Required before all other tools.",
  {
    port: z.number().default(9222).describe("CDP debug port (default: 9222)"),
    mode: z
      .enum(["chrome", "desktop"])
      .default("chrome")
      .describe(
        "chrome = Google Chrome (recommended, no Developer Mode needed), desktop = TradingView Desktop MSIX (requires Developer Mode)"
      ),
    wait_seconds: z
      .number()
      .default(5)
      .describe("Seconds to wait for the browser to start"),
  },
  async ({ port, mode, wait_seconds }) => {
    const already = await checkCDP(port);
    if (already.connected) {
      return {
        content: [
          {
            type: "text",
            text: `CDP already active on port ${port}. No need to relaunch.\n\nBrowser: ${already.info?.Browser || "unknown"}`,
          },
        ],
      };
    }

    if (mode === "chrome") {
      const chromePath = findChrome();
      if (!chromePath) {
        return {
          content: [
            {
              type: "text",
              text: "Google Chrome not found.\n\nInstall from: https://www.google.com/chrome/",
            },
          ],
          isError: true,
        };
      }

      const dataDir = `${process.env.TEMP || "C:\\temp"}\\chrome-tv-debug`;
      spawn(
        chromePath,
        [
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${dataDir}`,
          "https://www.tradingview.com/chart",
        ],
        { detached: true, stdio: "ignore", shell: false }
      ).unref();

      await new Promise((r) => setTimeout(r, wait_seconds * 1000));

      const check = await checkCDP(port);
      if (check.connected) {
        return {
          content: [
            {
              type: "text",
              text: `Chrome launched with TradingView.\n\nCDP port: ${port}\nBrowser: ${check.info?.Browser || "unknown"}\n\nNote: This uses a separate Chrome profile. Log into TradingView if needed on first use.`,
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: `Chrome launch command sent but CDP port ${port} not responding yet.\n\nWait a few seconds and run health_check.`,
            },
          ],
        };
      }
    }

    // mode === "desktop"
    const tv = findTVDesktop();
    if (!tv) {
      return {
        content: [
          {
            type: "text",
            text: "TradingView Desktop (MSIX) not found.\n\nInstall from: https://www.tradingview.com/desktop/\nThen enable Developer Mode: Windows Settings > System > For developers",
          },
        ],
        isError: true,
      };
    }

    const psCommand = `Invoke-CommandInDesktopPackage -PackageFamilyName '${tv.family}' -AppId 'TradingView.Desktop' -Command '${tv.exe}' -Args '--remote-debugging-port=${port}'`;
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
              text: `TradingView Desktop launched.\n\nCDP port: ${port}\nBrowser: ${check.info?.Browser || "unknown"}`,
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: `TradingView Desktop launch command sent but CDP port ${port} not responding.\n\nEnsure Developer Mode is ON: Windows Settings > System > For developers`,
            },
          ],
        };
      }
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to launch TradingView Desktop.\n\nError: ${err.message}\n\nRequirements:\n1. Developer Mode ON\n2. TradingView Desktop installed`,
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
  "Check if the browser is running with CDP enabled and a TradingView chart tab is open.",
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
            text: `CDP not responding on port ${port}.\n\nRun launch_browser first.`,
          },
        ],
        isError: true,
      };
    }

    const tab = await findTVTab(port);
    return {
      content: [
        {
          type: "text",
          text: tab
            ? `Connected.\n\nCDP port: ${port}\nBrowser: ${cdp.info?.Browser || "unknown"}\nTradingView tab: ${tab.url}\n\nReady for get_chart_state and other tools.`
            : `CDP is active but no TradingView tab found.\n\nBrowser: ${cdp.info?.Browser || "unknown"}\n\nOpen https://www.tradingview.com/chart in the browser.`,
        },
      ],
    };
  }
);

// --- Tool 3: get_chart_state ---
server.tool(
  "get_chart_state",
  "Read the current TradingView chart data: symbol, timeframe, OHLCV (from legend), and last price. Uses CDP WebSocket to evaluate JavaScript inside the chart page.",
  {
    port: z.number().default(9222).describe("CDP debug port (default: 9222)"),
  },
  async ({ port }) => {
    let session;
    try {
      session = await openTVSession(port);
      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: "No TradingView tab found. Run launch_browser first and make sure a chart is open.",
            },
          ],
          isError: true,
        };
      }

      const raw = await session.evaluate(JS_READ_CHART);
      const data = JSON.parse(raw);

      const lines = [];
      if (data.symbol) lines.push(`Symbol: ${data.symbol}`);
      if (data.timeframe) lines.push(`Timeframe: ${data.timeframe}`);
      if (data.lastPrice) lines.push(`Last price: ${data.lastPrice}`);
      if (data.open) lines.push(`O: ${data.open}  H: ${data.high}  L: ${data.low}  C: ${data.close}`);
      if (data.volume) lines.push(`Volume: ${data.volume}`);
      if (data.chartId) lines.push(`Chart ID: ${data.chartId}`);
      if (data.url) lines.push(`URL: ${data.url}`);

      return {
        content: [
          {
            type: "text",
            text: lines.length > 0
              ? `Chart data:\n\n${lines.join("\n")}`
              : "Connected to TradingView but could not extract chart data. Make sure a chart is loaded.",
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to read chart data.\n\nError: ${err.message}`,
          },
        ],
        isError: true,
      };
    } finally {
      session?.close();
    }
  }
);

// --- Tool 4: navigate ---
server.tool(
  "navigate",
  "Change the TradingView chart symbol and/or timeframe. Navigates to a new URL — the page will reload with the new settings.",
  {
    symbol: z
      .string()
      .optional()
      .describe(
        'Symbol to navigate to, e.g. "BTCUSD", "NASDAQ:AAPL", "BINANCE:ETHUSDT"'
      ),
    timeframe: z
      .string()
      .optional()
      .describe(
        'Timeframe to set, e.g. "1" (1min), "5" (5min), "15", "60" (1h), "240" (4h), "D" (daily), "W" (weekly), "M" (monthly)'
      ),
    port: z.number().default(9222).describe("CDP debug port (default: 9222)"),
  },
  async ({ symbol, timeframe, port }) => {
    if (!symbol && !timeframe) {
      return {
        content: [
          {
            type: "text",
            text: "Provide at least one of: symbol, timeframe.",
          },
        ],
        isError: true,
      };
    }

    let session;
    try {
      session = await openTVSession(port);
      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: "No TradingView tab found. Run launch_browser first.",
            },
          ],
          isError: true,
        };
      }

      const params = [];
      if (symbol) params.push(`symbol=${encodeURIComponent(symbol)}`);
      if (timeframe) params.push(`interval=${encodeURIComponent(timeframe)}`);
      const query = params.join("&");

      await session.evaluate(
        `(function() {
          var url = new URL(location.href);
          ${symbol ? `url.searchParams.set('symbol', ${JSON.stringify(symbol)});` : ""}
          ${timeframe ? `url.searchParams.set('interval', ${JSON.stringify(timeframe)});` : ""}
          location.href = url.toString();
        })()`
      );

      await new Promise((r) => setTimeout(r, 3000));

      // Re-read chart state after navigation
      session.close();
      session = await openTVSession(port);
      if (session) {
        const raw = await session.evaluate(JS_READ_CHART);
        const data = JSON.parse(raw);
        return {
          content: [
            {
              type: "text",
              text: `Navigated successfully.\n\nSymbol: ${data.symbol || "loading..."}\nTimeframe: ${data.timeframe || "loading..."}\nURL: ${data.url || "unknown"}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Navigation command sent.${symbol ? ` Symbol: ${symbol}` : ""}${timeframe ? ` Timeframe: ${timeframe}` : ""}\n\nPage is reloading. Run get_chart_state in a few seconds to verify.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Navigation failed.\n\nError: ${err.message}`,
          },
        ],
        isError: true,
      };
    } finally {
      session?.close();
    }
  }
);

// --- Tool 5: draw_lines ---
server.tool(
  "draw_lines",
  "Draw horizontal support/resistance lines on the TradingView chart at specified price levels. Uses TradingViewApi.activeChart().createShape().",
  {
    lines: z
      .array(
        z.object({
          price: z.number().describe("Price level for the horizontal line"),
          color: z
            .string()
            .default("#26A69A")
            .describe('Line color in hex, e.g. "#26A69A" (green), "#EF5350" (red), "#FF9800" (orange)'),
          label: z
            .string()
            .optional()
            .describe("Text label displayed on the line"),
          width: z.number().default(2).describe("Line width 1-4 (default: 2)"),
          style: z
            .number()
            .default(0)
            .describe("Line style: 0=solid, 1=dotted, 2=dashed (default: 0)"),
        })
      )
      .describe("Array of horizontal lines to draw"),
    port: z.number().default(9222).describe("CDP debug port (default: 9222)"),
  },
  async ({ lines, port }) => {
    let session;
    try {
      session = await openTVSession(port);
      if (!session) {
        return {
          content: [{ type: "text", text: "No TradingView tab found. Run launch_browser first." }],
          isError: true,
        };
      }

      const linesJson = JSON.stringify(lines);
      const result = await session.evaluate(`
        (async function() {
          var chart = TradingViewApi.activeChart();
          var time = Math.floor(Date.now() / 1000);
          var lines = ${linesJson};
          var ids = [];
          for (var i = 0; i < lines.length; i++) {
            var l = lines[i];
            var id = await chart.createShape(
              { time: time, price: l.price },
              {
                shape: "horizontal_line",
                lock: false,
                disableSelection: false,
                disableSave: false,
                overrides: {
                  linecolor: l.color || "#26A69A",
                  linewidth: l.width || 2,
                  linestyle: l.style || 0,
                  showPrice: true,
                  showLabel: !!(l.label),
                  text: l.label || "",
                  textcolor: l.color || "#26A69A",
                  fontsize: 12
                }
              }
            );
            ids.push(id);
          }
          return JSON.stringify({ count: ids.length, ids: ids });
        })()
      `);

      const data = JSON.parse(result);
      const summary = lines
        .map((l) => `  ${l.price}${l.label ? ` — ${l.label}` : ""}`)
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: `Drew ${data.count} horizontal line(s):\n\n${summary}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: "text", text: `Failed to draw lines.\n\nError: ${err.message}` },
        ],
        isError: true,
      };
    } finally {
      session?.close();
    }
  }
);

// --- Tool 6: draw_trendline ---
server.tool(
  "draw_trendline",
  "Draw a trendline between two points on the TradingView chart. Uses TradingViewApi.activeChart().createMultipointShape(). Specify start and end points with Unix timestamps (seconds) and prices.",
  {
    point1_time: z.number().describe("Unix timestamp (seconds) for the start point"),
    point1_price: z.number().describe("Price at the start point"),
    point2_time: z.number().describe("Unix timestamp (seconds) for the end point"),
    point2_price: z.number().describe("Price at the end point"),
    color: z.string().default("#2196F3").describe("Line color in hex (default: blue)"),
    width: z.number().default(2).describe("Line width 1-4 (default: 2)"),
    style: z.number().default(0).describe("0=solid, 1=dotted, 2=dashed"),
    extend_right: z.boolean().default(false).describe("Extend line to the right"),
    extend_left: z.boolean().default(false).describe("Extend line to the left"),
    label: z.string().optional().describe("Text label on the trendline"),
    port: z.number().default(9222).describe("CDP debug port (default: 9222)"),
  },
  async ({ point1_time, point1_price, point2_time, point2_price, color, width, style, extend_right, extend_left, label, port }) => {
    let session;
    try {
      session = await openTVSession(port);
      if (!session) {
        return {
          content: [{ type: "text", text: "No TradingView tab found. Run launch_browser first." }],
          isError: true,
        };
      }

      const result = await session.evaluate(`
        (async function() {
          var chart = TradingViewApi.activeChart();
          var id = await chart.createMultipointShape(
            [
              { time: ${point1_time}, price: ${point1_price} },
              { time: ${point2_time}, price: ${point2_price} }
            ],
            {
              shape: "trend_line",
              lock: false,
              disableSelection: false,
              disableSave: false,
              overrides: {
                linecolor: ${JSON.stringify(color)},
                linewidth: ${width},
                linestyle: ${style},
                extendRight: ${extend_right},
                extendLeft: ${extend_left},
                showLabel: ${!!(label)},
                text: ${JSON.stringify(label || "")},
                textcolor: ${JSON.stringify(color)},
                fontsize: 12
              }
            }
          );
          return JSON.stringify({ id: id });
        })()
      `);

      const data = JSON.parse(result);
      return {
        content: [
          {
            type: "text",
            text: `Trendline drawn.\n\nFrom: ${point1_price} → ${point2_price}${label ? `\nLabel: ${label}` : ""}\nID: ${data.id}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: "text", text: `Failed to draw trendline.\n\nError: ${err.message}` },
        ],
        isError: true,
      };
    } finally {
      session?.close();
    }
  }
);

// --- Tool 7: draw_rectangle ---
server.tool(
  "draw_rectangle",
  "Draw a rectangle zone on the TradingView chart (e.g. supply/demand zones, consolidation areas). Specify two corner points with Unix timestamps and prices.",
  {
    point1_time: z.number().describe("Unix timestamp (seconds) for corner 1"),
    point1_price: z.number().describe("Price at corner 1 (e.g. top of zone)"),
    point2_time: z.number().describe("Unix timestamp (seconds) for corner 2"),
    point2_price: z.number().describe("Price at corner 2 (e.g. bottom of zone)"),
    color: z
      .string()
      .default("rgba(38, 166, 154, 0.2)")
      .describe('Fill color with opacity, e.g. "rgba(38, 166, 154, 0.2)" for green zone'),
    border_color: z.string().default("#26A69A").describe("Border color in hex"),
    border_width: z.number().default(1).describe("Border width (default: 1)"),
    label: z.string().optional().describe("Text label inside the rectangle"),
    port: z.number().default(9222).describe("CDP debug port (default: 9222)"),
  },
  async ({ point1_time, point1_price, point2_time, point2_price, color, border_color, border_width, label, port }) => {
    let session;
    try {
      session = await openTVSession(port);
      if (!session) {
        return {
          content: [{ type: "text", text: "No TradingView tab found. Run launch_browser first." }],
          isError: true,
        };
      }

      const result = await session.evaluate(`
        (async function() {
          var chart = TradingViewApi.activeChart();
          var id = await chart.createMultipointShape(
            [
              { time: ${point1_time}, price: ${point1_price} },
              { time: ${point2_time}, price: ${point2_price} }
            ],
            {
              shape: "rectangle",
              lock: false,
              disableSelection: false,
              disableSave: false,
              overrides: {
                color: ${JSON.stringify(color)},
                borderColor: ${JSON.stringify(border_color)},
                borderWidth: ${border_width},
                showLabel: ${!!(label)},
                text: ${JSON.stringify(label || "")},
                fontsize: 12
              }
            }
          );
          return JSON.stringify({ id: id });
        })()
      `);

      const data = JSON.parse(result);
      return {
        content: [
          {
            type: "text",
            text: `Rectangle drawn.\n\nZone: ${point1_price} – ${point2_price}${label ? `\nLabel: ${label}` : ""}\nID: ${data.id}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: "text", text: `Failed to draw rectangle.\n\nError: ${err.message}` },
        ],
        isError: true,
      };
    } finally {
      session?.close();
    }
  }
);

// --- Tool 8: remove_drawings ---
server.tool(
  "remove_drawings",
  "Remove drawings from the TradingView chart. Can remove all shapes or specific ones by ID.",
  {
    ids: z
      .array(z.string())
      .optional()
      .describe("Specific shape IDs to remove. If omitted, removes ALL drawings."),
    port: z.number().default(9222).describe("CDP debug port (default: 9222)"),
  },
  async ({ ids, port }) => {
    let session;
    try {
      session = await openTVSession(port);
      if (!session) {
        return {
          content: [{ type: "text", text: "No TradingView tab found. Run launch_browser first." }],
          isError: true,
        };
      }

      if (ids && ids.length > 0) {
        const idsJson = JSON.stringify(ids);
        await session.evaluate(`
          (function() {
            var chart = TradingViewApi.activeChart();
            var ids = ${idsJson};
            for (var i = 0; i < ids.length; i++) {
              chart.removeEntity(ids[i]);
            }
          })()
        `);
        return {
          content: [
            { type: "text", text: `Removed ${ids.length} drawing(s).` },
          ],
        };
      } else {
        await session.evaluate(`TradingViewApi.activeChart().removeAllShapes()`);
        return {
          content: [
            { type: "text", text: "All drawings removed from the chart." },
          ],
        };
      }
    } catch (err) {
      return {
        content: [
          { type: "text", text: `Failed to remove drawings.\n\nError: ${err.message}` },
        ],
        isError: true,
      };
    } finally {
      session?.close();
    }
  }
);

// --- Tool 9: get_bars ---
server.tool(
  "get_bars",
  "Fetch OHLCV bar data (multiple candles) from the currently loaded TradingView chart. Uses TradingViewApi.activeChart().exportData() to get historical data that is already loaded in the chart.",
  {
    count: z
      .number()
      .default(100)
      .describe("Number of most recent bars to return (default: 100)"),
    include_studies: z
      .boolean()
      .default(false)
      .describe("Include indicator/study values in the output (default: false)"),
    port: z.number().default(9222).describe("CDP debug port (default: 9222)"),
  },
  async ({ count, include_studies, port }) => {
    let session;
    try {
      session = await openTVSession(port);
      if (!session) {
        return {
          content: [{ type: "text", text: "No TradingView tab found. Run launch_browser first." }],
          isError: true,
        };
      }

      const result = await session.evaluate(`
        (async function() {
          try {
            var chart = TradingViewApi.activeChart();
            var data = await chart.exportData({
              includeTime: true,
              includeSeries: true,
              includeStudies: ${include_studies}
            });
            var bars = data.data.slice(-${count});
            return JSON.stringify({
              schema: data.schema,
              total_loaded: data.data.length,
              returned: bars.length,
              bars: bars
            });
          } catch(e) {
            return JSON.stringify({ error: e.message || String(e) });
          }
        })()
      `);

      const data = JSON.parse(result);

      if (data.error) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to export chart data.\n\nError: ${data.error}\n\nThis may mean exportData() is not available. Try using evaluate tool to explore: TradingViewApi.activeChart()`,
            },
          ],
          isError: true,
        };
      }

      let output = `Bars: ${data.returned} of ${data.total_loaded} loaded\nSchema: ${data.schema.join(", ")}\n\n`;

      const maxPreview = Math.min(data.returned, 10);
      for (let i = 0; i < maxPreview; i++) {
        const bar = data.bars[i];
        const row = data.schema.map((col, j) => {
          if (col.toLowerCase() === "time") {
            return new Date(bar[j] * 1000).toISOString().slice(0, 16);
          }
          return bar[j];
        });
        output += row.join(" | ") + "\n";
      }

      if (data.returned > 10) {
        output += `... and ${data.returned - 10} more bars\n`;
      }

      output += `\nFull data returned as JSON in the bars array (${data.returned} rows x ${data.schema.length} columns).`;

      return {
        content: [
          { type: "text", text: output },
          { type: "text", text: JSON.stringify(data) },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: "text", text: `Failed to get bars.\n\nError: ${err.message}` },
        ],
        isError: true,
      };
    } finally {
      session?.close();
    }
  }
);

// --- Tool 10: create_indicator ---
server.tool(
  "create_indicator",
  'Add a technical indicator/study to the TradingView chart. Uses TradingViewApi.activeChart().createStudy(). Common names: "Moving Average", "RSI", "MACD", "Bollinger Bands", "EMA", "Volume", "Stochastic", "ATR", "Supertrend", "Ichimoku Cloud".',
  {
    name: z
      .string()
      .describe('Indicator name, e.g. "Moving Average", "RSI", "MACD", "Bollinger Bands", "EMA"'),
    inputs: z
      .record(z.any())
      .optional()
      .describe('Indicator inputs as key-value pairs, e.g. { "length": 20 } for MA or { "fast": 12, "slow": 26, "signal": 9 } for MACD'),
    force_overlay: z
      .boolean()
      .default(false)
      .describe("Force indicator to overlay on the main chart (default: false, uses indicator default)"),
    port: z.number().default(9222).describe("CDP debug port (default: 9222)"),
  },
  async ({ name, inputs, force_overlay, port }) => {
    let session;
    try {
      session = await openTVSession(port);
      if (!session) {
        return {
          content: [{ type: "text", text: "No TradingView tab found. Run launch_browser first." }],
          isError: true,
        };
      }

      const inputsArg = inputs ? JSON.stringify(inputs) : "{}";
      const result = await session.evaluate(`
        (async function() {
          try {
            var chart = TradingViewApi.activeChart();
            var id = await chart.createStudy(
              ${JSON.stringify(name)},
              ${force_overlay},
              false,
              ${inputsArg}
            );
            return JSON.stringify({ id: id, name: ${JSON.stringify(name)} });
          } catch(e) {
            return JSON.stringify({ error: e.message || String(e) });
          }
        })()
      `);

      const data = JSON.parse(result);

      if (data.error) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to add indicator "${name}".\n\nError: ${data.error}\n\nCheck the indicator name. Common names: "Moving Average", "RSI", "MACD", "Bollinger Bands", "EMA", "Volume", "Stochastic", "ATR".`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Indicator added: ${data.name}\nID: ${data.id}${inputs ? "\nInputs: " + JSON.stringify(inputs) : ""}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: "text", text: `Failed to add indicator.\n\nError: ${err.message}` },
        ],
        isError: true,
      };
    } finally {
      session?.close();
    }
  }
);

// --- Tool 11: pine_compile ---
server.tool(
  "pine_compile",
  "Write Pine Script code into the TradingView Pine Editor and compile it. Opens the Pine Editor if not visible, sets the code, and clicks compile. Note: this interacts with DOM elements which may break on TradingView UI updates.",
  {
    code: z
      .string()
      .describe("Pine Script source code to compile"),
    port: z.number().default(9222).describe("CDP debug port (default: 9222)"),
  },
  async ({ code, port }) => {
    let session;
    try {
      session = await openTVSession(port);
      if (!session) {
        return {
          content: [{ type: "text", text: "No TradingView tab found. Run launch_browser first." }],
          isError: true,
        };
      }

      const codeEscaped = JSON.stringify(code);
      const result = await session.evaluate(`
        (async function() {
          function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

          try {
            // 1. Open Pine Editor if not visible
            var pineTab = document.querySelector('[data-name="pine-editor"]');
            if (pineTab) { pineTab.click(); await sleep(500); }

            // 2. Find Monaco editor instance
            var editorEl = document.querySelector('.pine-editor-container .monaco-editor, [class*="pine-editor"] .monaco-editor');
            if (!editorEl) {
              // Try opening via bottom panel
              var bottomPanelBtn = document.querySelector('[data-name="scripteditor"]') ||
                                   document.querySelector('[id*="pine"]') ||
                                   document.querySelector('button[aria-label*="Pine"]');
              if (bottomPanelBtn) { bottomPanelBtn.click(); await sleep(1000); }
              editorEl = document.querySelector('.pine-editor-container .monaco-editor, [class*="pine-editor"] .monaco-editor');
            }

            if (!editorEl) {
              return JSON.stringify({ error: "Pine Editor not found. Open it manually first (Alt+P or click Pine Editor tab)." });
            }

            // 3. Set code via Monaco API
            var monacoEditor = editorEl.__proto__?.constructor?._instances?.values?.()?.next?.()?.value ||
                               monaco?.editor?.getEditors?.()[0] ||
                               monaco?.editor?.getModels?.()[0];

            if (monaco && monaco.editor) {
              var editors = monaco.editor.getEditors ? monaco.editor.getEditors() : [];
              if (editors.length > 0) {
                var model = editors[0].getModel();
                if (model) {
                  editors[0].setValue(${codeEscaped});
                  await sleep(300);
                }
              } else {
                var models = monaco.editor.getModels();
                if (models.length > 0) {
                  models[0].setValue(${codeEscaped});
                  await sleep(300);
                }
              }
            } else {
              return JSON.stringify({ error: "Monaco editor API not accessible." });
            }

            // 4. Click compile/add to chart button
            await sleep(500);
            var compileBtn = document.querySelector('[data-name="pine-editor-compile-button"]') ||
                             document.querySelector('button[class*="compile"]') ||
                             document.querySelector('[class*="pine-editor"] button[class*="apply"]');

            if (compileBtn) {
              compileBtn.click();
              await sleep(2000);

              // 5. Check for errors
              var errorEl = document.querySelector('[class*="pine-editor"] [class*="error"], [class*="compile-error"]');
              if (errorEl && errorEl.textContent.trim()) {
                return JSON.stringify({ compiled: false, error: errorEl.textContent.trim() });
              }
              return JSON.stringify({ compiled: true });
            } else {
              return JSON.stringify({ error: "Compile button not found. Code was set in editor — compile manually." });
            }
          } catch(e) {
            return JSON.stringify({ error: e.message || String(e) });
          }
        })()
      `);

      const data = JSON.parse(result);

      if (data.error) {
        return {
          content: [
            {
              type: "text",
              text: `Pine Script issue.\n\n${data.error}\n\nTip: Make sure the Pine Editor tab is visible (press Alt+P).`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: data.compiled
              ? "Pine Script compiled and added to chart."
              : `Pine Script set in editor but compilation status unknown.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: "text", text: `Failed to compile Pine Script.\n\nError: ${err.message}` },
        ],
        isError: true,
      };
    } finally {
      session?.close();
    }
  }
);

// --- Tool 12: evaluate ---
server.tool(
  "evaluate",
  "Execute arbitrary JavaScript inside the TradingView chart page via CDP. Use this for advanced interactions: reading indicators, interacting with Pine Editor, opening Strategy Tester, clicking UI elements, or any action not covered by other tools. Returns the result of the expression.",
  {
    expression: z
      .string()
      .describe(
        "JavaScript code to evaluate in the TradingView page context. Wrap in an IIFE for multi-statement code: (function(){ ... })()"
      ),
    port: z.number().default(9222).describe("CDP debug port (default: 9222)"),
  },
  async ({ expression, port }) => {
    let session;
    try {
      session = await openTVSession(port);
      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: "No TradingView tab found. Run launch_browser first.",
            },
          ],
          isError: true,
        };
      }

      const result = await session.evaluate(expression);
      const output =
        result === undefined
          ? "undefined"
          : typeof result === "string"
            ? result
            : JSON.stringify(result, null, 2);

      return {
        content: [{ type: "text", text: output }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `JavaScript evaluation failed.\n\nError: ${err.message}`,
          },
        ],
        isError: true,
      };
    } finally {
      session?.close();
    }
  }
);

// --- Start server ---
const transport = new StdioServerTransport();
await server.connect(transport);
