/**
 * Pi RPC Client
 *
 * Spawns `pi --mode rpc` as a subprocess and communicates via JSON-Lines
 * over stdin/stdout. Provides a clean async API for sending prompts and
 * receiving structured responses.
 *
 * Pi RPC Protocol: https://pi.dev/docs/latest/rpc
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

export class PiRPCClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.process = null;
    this.readline = null;
    this.pendingRequests = new Map();
    this.requestId = 0;
    this.ready = false;
    this.readyPromise = null;

    this.piPath = options.piPath || "pi";
    this.startupTimeout = options.startupTimeout || 10000;
    this.promptTimeout = options.promptTimeout || 120000;
    this.extraArgs = options.extraArgs || [];
  }

  /**
   * Start Pi in RPC mode. Returns a promise that resolves when Pi is ready.
   */
  async start() {
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Pi RPC startup timed out"));
      }, this.startupTimeout);

      try {
        const args = ["--mode", "rpc", ...this.extraArgs];

        this.process = spawn(this.piPath, args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env },
        });

        // Handle stdout — JSON-Lines protocol
        this.readline = createInterface({ input: this.process.stdout });
        this.readline.on("line", (line) => {
          try {
            const msg = JSON.parse(line);
            this._handleMessage(msg);
          } catch (err) {
            // Skip malformed lines (e.g., Pi's startup banner)
          }
        });

        // Handle stderr — Pi logs diagnostic info here
        this.process.stderr.on("data", (data) => {
          const text = data.toString().trim();
          if (text) console.log(`[pi:stderr] ${text}`);
        });

        // Handle process exit
        this.process.on("exit", (code, signal) => {
          console.log(`[pi] process exited (code=${code}, signal=${signal})`);
          this.ready = false;
          this.emit("exit", { code, signal });
          // Reject all pending requests
          for (const [id, { reject }] of this.pendingRequests) {
            reject(new Error(`Pi process exited (code=${code})`));
          }
          this.pendingRequests.clear();
        });

        this.process.on("error", (err) => {
          console.error(`[pi] process error:`, err.message);
          reject(err);
        });

        // Give Pi a moment to initialize
        // We consider it ready once we can send commands
        await new Promise((r) => setTimeout(r, 1500));
        this.ready = true;
        clearTimeout(timer);
        console.log(`[pi] RPC mode started (pid=${this.process.pid})`);
        resolve();
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });

    return this.readyPromise;
  }

  /**
   * Handle an incoming JSON message from Pi's stdout.
   */
  _handleMessage(msg) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case "response":
        // Command response — resolve the pending request
        this._resolvePending(msg);
        break;

      case "agent_start":
        this.emit("agent_start");
        break;

      case "agent_end":
        this.emit("agent_end", msg);
        break;

      case "turn_start":
        this.emit("turn_start");
        break;

      case "turn_end":
        this.emit("turn_end", msg);
        break;

      case "message_start":
        this.emit("message_start", msg);
        break;

      case "message_update":
        this.emit("message_update", msg);
        break;

      case "message_end":
        this.emit("message_end", msg);
        break;

      case "session":
        // Session header — first message from Pi
        this.emit("session", msg);
        break;

      default:
        // Forward unknown events
        this.emit(msg.type, msg);
    }
  }

  /**
   * Resolve a pending request by matching its id.
   */
  _resolvePending(msg) {
    const id = msg.id;
    if (id && this.pendingRequests.has(id)) {
      const { resolve } = this.pendingRequests.get(id);
      this.pendingRequests.delete(id);
      resolve(msg);
    }
  }

  /**
   * Send a JSON command to Pi's stdin and wait for the response.
   */
  async sendCommand(command) {
    if (!this.ready || !this.process) {
      await this.start();
    }

    return new Promise((resolve, reject) => {
      const id = command.id || `req-${++this.requestId}`;
      const payload = { id, ...command, id: undefined };

      // Restore id as top-level field (we spread it above)
      payload.id = id;

      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Pi RPC command timed out: ${command.type}`));
        }
      }, this.promptTimeout);

      this.pendingRequests.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      const line = JSON.stringify(payload) + "\n";
      this.process.stdin.write(line);
    });
  }

  /**
   * Send a prompt to Pi and wait for the agent to finish.
   * Returns the parsed response text.
   */
  async prompt(message, options = {}) {
    const response = await this.sendCommand({
      type: "prompt",
      message,
      streamingBehavior: options.streamingBehavior,
    });

    if (!response.success) {
      throw new Error(response.error || "Pi prompt command failed");
    }

    // Wait for agent_end event to get the full result
    return new Promise((resolve, reject) => {
      const onAgentEnd = (msg) => {
        this.removeListener("agent_end", onAgentEnd);
        cleanup();
        resolve(msg);
      };

      const onError = (err) => {
        this.removeListener("agent_end", onAgentEnd);
        cleanup();
        reject(err);
      };

      const timer = setTimeout(() => {
        this.removeListener("agent_end", onAgentEnd);
        cleanup();
        reject(new Error("Pi agent did not complete within timeout"));
      }, this.promptTimeout);

      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener("exit", onExit);
      };

      const onExit = (info) => {
        this.removeListener("agent_end", onAgentEnd);
        cleanup();
        reject(new Error(`Pi process exited during prompt (code=${info.code})`));
      };

      this.on("agent_end", onAgentEnd);
      this.on("exit", onExit);
    });
  }

  /**
   * Extract structured job info from markdown content.
   * Returns a parsed object with company, title, location, etc.
   */
  async extractJobInfo(markdown) {
    const promptText = `Extract structured information from this job description.
Return ONLY valid JSON with these fields (use null for missing):
{
  "company": string | null,    // Company name
  "title": string | null,      // Job title
  "location": string | null,   // Job location
  "deadline": string | null,   // Application deadline if mentioned
  "role_type": string | null,  // "Full-time", "Contract", "Internship", etc.
  "job_id": string | null,     // Requisition/Job ID from posting
  "summary": string | null     // 1-2 sentence summary of the role
}

Job Description:
${markdown}`;

    const agentEndMsg = await this.prompt(promptText);
    return this._parseAgentResponse(agentEndMsg);
  }

  /**
   * Parse the agent_end message to extract the structured JSON from the assistant's text.
   */
  _parseAgentResponse(agentEndMsg) {
    const messages = agentEndMsg?.messages ?? [];

    // Find the last assistant message
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant");

    if (!lastAssistant) return {};

    // Extract text content from all content blocks
    const text = (lastAssistant.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    // Find JSON object in the text
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};

    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      console.error("[pi] Failed to parse JSON from response:", text.slice(0, 200));
      return {};
    }
  }

  /**
   * Stop the Pi subprocess.
   */
  async stop() {
    if (!this.process) return;

    this.ready = false;

    return new Promise((resolve) => {
      const pid = this.process.pid;

      // Try graceful shutdown first
      this.process.on("exit", () => {
        console.log(`[pi] process ${pid} stopped`);
        resolve();
      });

      this.process.kill("SIGTERM");

      // Force kill after 3 seconds
      setTimeout(() => {
        try {
          this.process.kill("SIGKILL");
        } catch { /* already dead */ }
        resolve();
      }, 3000);
    });
  }
}
