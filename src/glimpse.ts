/**
 * Local wrapper around glimpseui's open() that suppresses Chromium stderr noise.
 *
 * The upstream open() spawns the host process with `stderr: 'inherit'`, which
 * leaks Chromium ERROR lines (ozone/Vulkan, DBus/UPower, etc.) into the pi
 * terminal.  We duplicate the spawn + protocol logic here with
 * `stderr: 'ignore'` instead.
 */

import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { getNativeHostInfo } from "glimpseui";

export interface GlimpseWindow extends EventEmitter {
  send(js: string): void;
  close(): void;
}

class Window extends EventEmitter implements GlimpseWindow {
  #proc: ReturnType<typeof spawn>;
  #closed = false;
  #pendingHTML: string | null;

  constructor(proc: ReturnType<typeof spawn>, initialHTML: string) {
    super();
    this.#proc = proc;
    this.#pendingHTML = initialHTML;

    proc.stdin.on("error", () => {});

    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });

    rl.on("line", (line: string) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }

      switch (msg.type) {
        case "ready": {
          // First ready = blank page loaded. Send pending HTML if we have it,
          // otherwise forward the event.  Matches upstream GlimpseWindow logic.
          if (this.#pendingHTML) {
            this.#sendHTML(this.#pendingHTML);
            this.#pendingHTML = null;
          } else {
            this.emit("ready", msg);
          }
          break;
        }
        case "info":
          this.emit("info", msg);
          break;
        case "message":
          this.emit("message", msg.data);
          break;
        case "click":
          this.emit("click");
          break;
        case "closed":
          if (!this.#closed) {
            this.#closed = true;
            this.emit("closed");
          }
          break;
      }
    });

    proc.on("error", (err: Error) => this.emit("error", err));
    proc.on("exit", () => {
      if (!this.#closed) {
        this.#closed = true;
        this.emit("closed");
      }
    });
  }

  #write(obj: any) {
    if (this.#closed) return;
    this.#proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  #sendHTML(html: string) {
    this.#write({ type: "html", html: Buffer.from(html).toString("base64") });
  }

  send(js: string) {
    this.#write({ type: "eval", js });
  }

  close() {
    this.#write({ type: "close" });
  }
}

export function open(
  html: string,
  options: { width?: number; height?: number; title?: string } = {},
): GlimpseWindow {
  const host = getNativeHostInfo();

  const args: string[] = [];
  if (options.width != null) args.push("--width", String(options.width));
  if (options.height != null) args.push("--height", String(options.height));
  if (options.title != null) args.push("--title", options.title);

  const spawnArgs = [...(host.extraArgs || []), ...args];
  const proc = spawn(host.path, spawnArgs, {
    stdio: ["pipe", "pipe", "ignore"], // stderr suppressed — the only change
    windowsHide: process.platform === "win32",
  });

  return new Window(proc, html);
}
