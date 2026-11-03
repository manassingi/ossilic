/**
 * @ossilic/mujoco — Node entry: the driver plus a child-process transport
 * that runs the Python host.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MujocoDriver, type MujocoConfig, type Transport } from "./driver.ts";

export * from "./driver.ts";

export const HOST = fileURLToPath(new URL("../host/ossilic_mujoco.py", import.meta.url));

/** OSSILIC_PYTHON, else a .venv found above `from`, else python3. */
export function findPython(from: string): string {
  if (process.env.OSSILIC_PYTHON) return process.env.OSSILIC_PYTHON;
  for (let dir = from; ; dir = dirname(dir)) {
    const venv = join(dir, ".venv/bin/python");
    if (existsSync(venv)) return venv;
    if (dirname(dir) === dir) return "python3";
  }
}

/** One request in flight at a time; replies come back in order. */
export class ProcessTransport implements Transport {
  #child: ChildProcess;
  #queue: Array<(reply: Record<string, any>) => void> = [];
  #buffer = "";
  #stderr = "";

  constructor(command: string, args: string[]) {
    this.#child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.#child.stdout!.on("data", (chunk) => {
      this.#buffer += chunk;
      let nl;
      while ((nl = this.#buffer.indexOf("\n")) >= 0) {
        const line = this.#buffer.slice(0, nl);
        this.#buffer = this.#buffer.slice(nl + 1);
        this.#queue.shift()?.(JSON.parse(line));
      }
    });
    this.#child.stderr!.on("data", (chunk) => (this.#stderr += chunk));
    this.#child.on("exit", (code) => { for (const r of this.#queue.splice(0)) r({ ok: false, error: `host exited with code ${code}\n${this.#stderr.trim()}` }); });
  }

  request(message: object): Promise<Record<string, any>> {
    return new Promise((resolve) => { this.#queue.push(resolve); this.#child.stdin!.write(JSON.stringify(message) + "\n"); });
  }

  close(): void { this.#child.kill(); }
}


export function createMujocoDriver(config: MujocoConfig & { python?: string }, dir: string): MujocoDriver {
  const { python, ...rest } = config;
  return new MujocoDriver(rest, dir, new ProcessTransport(python ?? findPython(dir), [HOST]));
}
