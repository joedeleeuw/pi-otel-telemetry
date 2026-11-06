import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
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

async function memoryUnchecked(event: "recall" | "capture", payload: Record<string, unknown>): Promise<MemoryResult> {
  const child = spawn(HOOK, ["pi", event], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exit = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? -1));
  });
  child.stdin.end(JSON.stringify(payload));
  const code = await exit;
  if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `dotfiles-memory-hook exited ${code}`);
  return JSON.parse(stdout) as MemoryResult;
}

async function memory(event: "recall" | "capture", payload: Record<string, unknown>): Promise<MemoryResult> {
  try {
    return await memoryUnchecked(event, payload);
  } catch (error) {
    return { ok: false, code: "request_failed", message: error instanceof Error ? error.message : String(error) };
  }
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
