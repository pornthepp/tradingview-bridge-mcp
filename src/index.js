#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync, spawn } from "child_process";
import { existsSync } from "fs";
import http from "http";

const server = new McpServer({
  name: "tradingview-bridge",
  version: "1.0.0",
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

// --- Helper: get chart state via CDP ---
function getChartState(port = 9222) {
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
          if (!tvTab) return resolve({ found: false });
          if (!tvTab.webSocketDebuggerUrl) return resolve({ found: false });

          resolve({
            found: true,
            url: tvTab.url,
            title: tvTab.title,
            targetId: tvTab.id,
          });
        } catch {
          resolve({ found: false });
        }
      });
    });
    req.on("error", () => resolve({ found: false }));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve({ found: false });
    });
  });
}

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
  "Read the current TradingView chart state including symbol, URL, and active tab info via CDP.",
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

    const state = await getChartState(port);

    if (!state.found) {
      return {
        content: [
          {
            type: "text",
            text: `TradingView is running but no chart tab found.\n\nMake sure a chart is open in TradingView Desktop.`,
          },
        ],
      };
    }

    const urlMatch = state.url?.match(/tradingview\.com\/chart\/([^/]+)/);
    const chartId = urlMatch?.[1] || "unknown";

    return {
      content: [
        {
          type: "text",
          text: `Chart state retrieved.\n\nChart ID: ${chartId}\nTitle: ${state.title || "unknown"}\nURL: ${state.url}`,
        },
      ],
    };
  }
);

// --- Start server ---
const transport = new StdioServerTransport();
await server.connect(transport);
