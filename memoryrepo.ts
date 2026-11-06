import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const execute = promisify(execFile);
const HOOK = process.env.MEMORYREPO_HOOK ?? `${process.env.HOME}/.local/bin/dotfiles-memory-hook`;

type MemoryResult = {
  ok: boolean;
  additionalContext?: string;
  code?: string;
  message?: string;
};

type ContentMessage = {
  role?: string;
  content?: unknown;
};

function textOf(message: ContentMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const candidate = part as Record<string, unknown>;
    return candidate.type === "text" && typeof candidate.text === "string" ? [candidate.text] : [];
  }).join("\n");
}

async function memory(event: "recall" | "capture", payload: Record<string, unknown>): Promise<MemoryResult> {
  const { stdout } = await execute(HOOK, ["pi", event], {
    input: JSON.stringify(payload),
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout) as MemoryResult;
}

function notify(ctx: ExtensionContext, result: MemoryResult): void {
  if (!result.ok) ctx.ui.notify(`Memoryrepo ${result.code ?? "request_failed"}: ${result.message ?? "unknown error"}`, "error");
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    if (event.messageType !== "user") return;
    const result = await memory("recall", {
      cwd: ctx.cwd,
      session_id: ctx.sessionManager.getSessionId(),
      prompt: event.prompt,
    });
    if (result.ok && result.additionalContext) {
      event.systemPromptOptions.appendSystemPrompt = [event.systemPromptOptions.appendSystemPrompt, result.additionalContext]
        .filter(Boolean)
        .join("\n\n");
      return;
    }
    notify(ctx, result);
  });

  pi.on("agent_end", async (event, ctx) => {
    const messages = (event.messages as ContentMessage[]).flatMap((message, index) => {
      if (message.role !== "user" && message.role !== "assistant") return [];
      const content = textOf(message);
      return content ? [{ index: index + 1, role: message.role, content }] : [];
    });
    if (messages.length === 0) return;
    const result = await memory("capture", {
      cwd: ctx.cwd,
      session_id: ctx.sessionManager.getSessionId(),
      messages,
    });
    notify(ctx, result);
  });
}
