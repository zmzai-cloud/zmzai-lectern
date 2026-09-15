import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { EngineRuntime, expandPlaceholders, collectMcpEntries } from "./engine.js";

function makeRuntime() {
  const dataDir = mkdtempSync(join(tmpdir(), "harness-test-data-"));
  const ws = mkdtempSync(join(tmpdir(), "harness-test-ws-"));
  writeFileSync(join(ws, "hello.txt"), "hi");
  mkdirSync(join(ws, "sub"));
  writeFileSync(join(ws, "sub", "nested.txt"), "nested");
  return new EngineRuntime({ dataDir, workspaceRoot: ws });
}

describe("EngineRuntime 路径越界防护", () => {
  it("readFile 拒绝 ../ 逃逸与工作区外绝对路径", async () => {
    const rt = makeRuntime();
    await expect(rt.readFile("../escape.txt")).resolves.toBeNull();
    await expect(rt.readFile("sub/../../escape.txt")).resolves.toBeNull();
    const outside = join(tmpdir(), "outside-secret.txt");
    writeFileSync(outside, "secret");
    await expect(rt.readFile(outside)).resolves.toBeNull(); // 绝对路径直接逃出 workspace root
    await expect(rt.readFile("/etc/hosts")).resolves.toBeNull();
    await expect(rt.readFile("hello.txt")).resolves.toBe("hi");
  });

  it("listDir 对越界路径返回空数组，正常相对路径可用", async () => {
    const rt = makeRuntime();
    await expect(rt.listDir("../")).resolves.toEqual([]);
    await expect(rt.listDir("..")).resolves.toEqual([]);
    const root = await rt.listDir("");
    expect(root.map((e) => e.name).sort()).toEqual(["hello.txt", "sub"]);
    const sub = await rt.listDir("sub");
    expect(sub).toEqual([expect.objectContaining({ name: "nested.txt", isDirectory: false })]);
  });
});

describe("expandPlaceholders / collectMcpEntries", () => {
  it("展开 PLUGIN_ROOT/PLUGIN_DATA 并做 server 名限定", () => {
    expect(expandPlaceholders("a${PLUGIN_ROOT}b/${PLUGIN_DATA}", { "${PLUGIN_ROOT}": "/R", "${PLUGIN_DATA}": "/D" })).toBe(
      "a/Rb//D",
    );

    // 用 resolve 归一化：实现侧 collectMcpEntries 内部即 resolve(pluginsRoot, name)，
    // Windows 下会把无盘符路径补成当前盘（D:\ws\...），测试若直接用 POSIX 字面量 + join
    // 会得到不带盘符的 \ws\...，两侧必然不等。
    const pluginsRoot = resolve("/ws/.zmzai/plugins");
    const dataRoot = resolve("/data/plugins");
    const entries = collectMcpEntries({
      pluginsRoot,
      pluginDataRoot: dataRoot,
      parsed: [
        {
          manifest: { name: "demo" },
          mcpServers: {
            local: {
              type: "stdio",
              command: "${PLUGIN_ROOT}/bin/server.mjs",
              args: ["--data", "${PLUGIN_DATA}"],
              cwd: "${PLUGIN_ROOT}",
            },
            remote: { type: "sse", url: "https://mcp.example.com/sse" },
          },
        },
      ],
    });

    expect(entries.map((e) => e.name)).toEqual(["demo:local", "demo:remote"]);
    const [local, remote] = entries;
    if (local.spec.type !== "stdio") throw new Error("应为 stdio");
    expect(local.spec.command).toBe(join(pluginsRoot, "demo") + "/bin/server.mjs");
    expect(local.spec.args).toEqual(["--data", join(dataRoot, "demo")]);
    expect(local.spec.cwd).toBe(join(pluginsRoot, "demo"));
    if (remote.spec.type !== "sse") throw new Error("远端应原样透传");
    expect(remote.spec.url).toBe("https://mcp.example.com/sse");
  });

  it("initMcpServers 在无插件时返回空且不抛错", async () => {
    const rt = makeRuntime();
    await expect(rt.initMcpServers()).resolves.toEqual([]);
    rt.dispose();
  });

  it("构造时注入基线本地工具：git 四件 + 终端五件绑定 workspaceRoot", () => {
    const rt = makeRuntime();
    const ids = rt.localToolIds();
    expect(ids.slice(0, 4)).toEqual(["git_status", "git_diff", "git_log", "git_commit"]);
    expect(ids.slice(4)).toEqual(["terminal_start", "terminal_read", "terminal_write", "terminal_kill", "terminal_list"]);
    // MCP 重扫后基线仍在
    return rt.initMcpServers().then(() => {
      expect(rt.localToolIds()).toHaveLength(9);
      rt.dispose();
    });
  });

  it("终端端到端：start 启动真进程、read 读到输出并标注退出码", async () => {
    const rt = makeRuntime();
    const started = await rt.runLocalTool("terminal_start", { command: "echo terminal_e2e_ok" });
    const meta = started.metadata as { sessionId: string };
    expect(meta.sessionId).toMatch(/^tty_/);
    // 轮询直到进程退出（退出态会在 read 输出里注明）。Windows 侧终端优先
    // pwsh/powershell（framework Windows 加固），冷启动在 CI runner 上可达数秒，
    // 因此预算按「真实进程退出」而非「shell 多快启动」设定。
    let output = "";
    let status = "";
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const res = await rt.runLocalTool("terminal_read", { sessionId: meta.sessionId, since: 0 });
      output = res.output;
      status = (res.metadata as { status?: string }).status ?? "";
      if (status !== "running") break;
    }
    expect(output).toContain("terminal_e2e_ok");
    expect(status).toBe("exited");
  }, 30_000);

  it("git_status 端到端：本机工具注入后可对真实仓库执行并读出变更", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const dataDir = mkdtempSync(join(tmpdir(), "harness-git-data-"));
    const ws = mkdtempSync(join(tmpdir(), "harness-git-ws-"));
    writeFileSync(join(ws, "tracked.txt"), "v1\n");
    try {
      await exec("git", ["init"], { cwd: ws });
      await exec("git", ["config", "user.email", "t@example.com"], { cwd: ws });
      await exec("git", ["config", "user.name", "T"], { cwd: ws });
      await exec("git", ["add", "."], { cwd: ws });
      await exec("git", ["commit", "-m", "init"], { cwd: ws });
    } catch {
      return; // 环境无 git 时跳过（框架侧已有 skipIf 完整覆盖）
    }
    writeFileSync(join(ws, "notes.md"), "untracked\n");
    const rt = new EngineRuntime({ dataDir, workspaceRoot: ws });
    expect(rt.localToolIds().slice(0, 4)).toEqual(["git_status", "git_diff", "git_log", "git_commit"]);

    const res = await rt.runLocalTool("git_status", {});
    expect(res.output).toContain("分支");
    expect(res.output).toContain("notes.md");
    // 参数校验路径
    await expect(rt.runLocalTool("git_commit", {})).rejects.toThrow(/message/);
  }, 20_000);
});
