import { Type } from "../pi-sdk/index.js";
import { getToolSessionPath } from "./tool-session.js";
import { t } from "../../server/i18n.js";

const READ_ACTIONS = new Set(["read", "list"]);

function jsonResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function textResult(text, details = {}) {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function normalizeAction(action) {
  const text = typeof action === "string" ? action.trim().toLowerCase() : "";
  if (["start", "write", "read", "close", "list"].includes(text)) return text;
  return "";
}

function optionalNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function createTerminalTool({
  getTerminalSessionManager,
  getAgentId,
  getCwd,
} = {}) {
  return {
    name: "terminal",
    label: t("toolDef.terminal.label"),
    description: t("toolDef.terminal.description"),
    parameters: Type.Object({
      action: Type.String({ description: t("toolDef.terminal.actionDesc") }),
      terminal_id: Type.Optional(Type.String({ description: t("toolDef.terminal.terminalIdDesc") })),
      command: Type.Optional(Type.String({ description: t("toolDef.terminal.commandDesc") })),
      chars: Type.Optional(Type.String({ description: t("toolDef.terminal.charsDesc") })),
      cwd: Type.Optional(Type.String({ description: t("toolDef.terminal.cwdDesc") })),
      label: Type.Optional(Type.String({ description: t("toolDef.terminal.labelDesc") })),
      since_seq: Type.Optional(Type.Number({ description: t("toolDef.terminal.sinceSeqDesc") })),
      cols: Type.Optional(Type.Number({ description: t("toolDef.terminal.colsDesc") })),
      rows: Type.Optional(Type.Number({ description: t("toolDef.terminal.rowsDesc") })),
    }),
    execute: async (_toolCallId, params = {}, _signal, _onUpdate, ctx) => {
      const action = normalizeAction(params.action);
      if (!action) {
        return textResult("terminal action must be one of: start, write, read, close, list", {
          errorCode: "TERMINAL_INVALID_ACTION",
        });
      }
      const sessionPath = getToolSessionPath(ctx);
      if (!sessionPath) {
        return textResult("current session is required to use terminal", {
          errorCode: "TERMINAL_SESSION_REQUIRED",
        });
      }
      const manager = getTerminalSessionManager?.();
      if (!manager) {
        return textResult("terminal manager unavailable", {
          errorCode: "TERMINAL_MANAGER_UNAVAILABLE",
        });
      }

      if (action === "list") {
        return jsonResult(manager.list(sessionPath));
      }

      if (action === "start") {
        const cwd = params.cwd || ctx?.sessionManager?.getCwd?.() || getCwd?.() || process.cwd();
        const result = await manager.start({
          sessionPath,
          agentId: getAgentId?.() || "",
          cwd,
          command: params.command || "",
          label: params.label || "",
          cols: optionalNumber(params.cols, 80),
          rows: optionalNumber(params.rows, 24),
        });
        return jsonResult(result);
      }

      const terminalId = params.terminal_id || params.terminalId;
      if (!terminalId) {
        return textResult("terminal_id is required", {
          errorCode: "TERMINAL_ID_REQUIRED",
          action,
        });
      }

      if (action === "read") {
        return jsonResult(manager.read({
          sessionPath,
          terminalId,
          sinceSeq: optionalNumber(params.since_seq, 0),
        }));
      }

      if (action === "write") {
        return jsonResult(manager.write({
          sessionPath,
          terminalId,
          chars: params.chars || "",
        }));
      }

      if (action === "close") {
        return jsonResult(manager.close({ sessionPath, terminalId }));
      }

      return textResult(`terminal action ${action} is not implemented`, {
        errorCode: "TERMINAL_ACTION_UNIMPLEMENTED",
        action,
        readOnlyAction: READ_ACTIONS.has(action),
      });
    },
  };
}
