"use strict";

/**
 * Adapter from the plugin-facing host API to what the sync engine expects.
 *
 * The only host surface used here is the reviewed desktop operation catalog
 * (requires the `desktop.control` grant):
 *
 *   session/list  -> { sessions: SessionSummary[] }
 *   session/get   -> { session: SessionDetail }
 *
 * Both were verified against PI-Desktop's own IPC handlers, which is why the
 * argument shapes below are exact rather than defensive.
 */

const core = require("./recorder-core");

function createHostAdapter(pi) {
  if (!pi || !pi.desktop || typeof pi.desktop.invoke !== "function") {
    throw new Error("host adapter requires pi.desktop.invoke");
  }

  async function invoke(operation, args = []) {
    return pi.desktop.invoke({ operation, args });
  }

  return {
    async listSessions() {
      const reply = await invoke("session/list", []);
      return core.extractSessionList(reply);
    },
    async getSession(request) {
      return invoke("session/get", [request]);
    },
    async listOperations() {
      try {
        return await pi.desktop.listOperations();
      } catch {
        return [];
      }
    },
  };
}

module.exports = { createHostAdapter };
