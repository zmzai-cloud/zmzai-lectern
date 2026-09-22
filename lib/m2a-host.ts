import { readFileSync } from "node:fs";

/** M2a 实验代理：Next → Host 的受控通道（token 只经 host.json 文件读取）。
 *  M2b 起随路由族迁移被 HostService 门面替代。 */
export type HostBootstrap = { port: number; token: string };

export function hostBootstrap(): HostBootstrap {
  const path = process.env.LECTERN_HOST_BOOTSTRAP;
  if (!path) throw new Error("M2A_HOST_NOT_CONFIGURED");
  return JSON.parse(readFileSync(path, "utf8")) as HostBootstrap;
}

export function hostFetch(path: string, init?: RequestInit): Promise<Response> {
  const bootstrap = hostBootstrap();
  return fetch(`http://127.0.0.1:${bootstrap.port}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${bootstrap.token}`, ...(init?.headers ?? {}) },
  });
}
