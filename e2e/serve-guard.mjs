import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/** 确认「被测服务就是本仓这次的构建」。
 *
 *  【为什么需要它】本机开发时 Lectern 桌面应用自己也会监听 3100（electron/web-server.cjs），
 *  它服务的是**应用自带的那份** Next 产物。于是 `http://127.0.0.1:3100` 到底落到桌面应用
 *  还是 `pnpm start` 那个 node 进程，取决于谁先绑上 IPv4——实测两者可以同时存在
 *  （一个 IPv4 一个 IPv6），`lsof` 看得到两条 LISTEN，curl 两个地址返回的 HTML 引用
 *  不同的 `page-<hash>.js`。
 *
 *  这个坑的代价是不对称的：指向旧产物时，脚本会拿**改之前的界面**去比**改之后的断言**，
 *  报出来的失败与自己刚写的代码毫无关系（真实耗时：一个多小时的错误方向排查，
 *  最后靠 grep 产物里的 `evidenceCount` 才怀疑到「跑的根本不是这份代码」）。
 *
 *  所以这里不去猜端口，而是**验证证据链**：HTML 引用的根路由 chunk 必须在本仓
 *  `.next/static/chunks/app/` 里存在。存在的意义不是「文件在」这件事本身，而是
 *  「被告服务的产物 == 工作区里刚构建的产物」——两者不同就立刻停下并说清病因，
 *  让失败落在正确的地方。
 *
 *  CI 里三个 job 都是 `pnpm build && pnpm start`，同目录同产物，恒过。 */
export async function assertServingThisBuild(page, url) {
  const buildDir = path.join(process.cwd(), ".next");
  if (!existsSync(path.join(buildDir, "BUILD_ID"))) {
    throw new Error(`未找到 ${buildDir} 的构建产物——先跑 pnpm build 再跑本用例。`);
  }
  const appChunks = path.join(buildDir, "static", "chunks", "app");
  // 根路由（app/page.tsx）在 app/ 顶层且恒为唯一的 page-*.js；嵌套路由在各自子目录里。
  const ours = existsSync(appChunks) ? readdirSync(appChunks).filter((f) => /^page-[a-z0-9]+\.js$/.test(f)) : [];
  if (ours.length === 0) throw new Error(`${appChunks} 里没有根路由 chunk——产物不完整，重跑 pnpm build。`);

  const html = await (await fetch(url, { redirect: "follow" })).text();
  const served = html.match(/page-[a-z0-9]+\.js/)?.[0];
  if (!served) throw new Error(`${url} 返回的 HTML 里没有根路由 chunk，不是 Lectern 页面？`);
  if (ours.includes(served)) return;

  throw new Error(
    [
      `${url} 服务的不是本仓这次的构建：`,
      `  它给的根路由 chunk = ${served}`,
      `  本仓 .next 里的     = ${ours.join(", ")}`,
      "多半是该端口被另一个进程占了——最常见的是正在运行的 Lectern 桌面应用（它自己服务一份自带产物）。",
      "处理办法：换一个空闲端口起服务并把 LECTERN_TEST_URL 指过去，",
      `或先确认占用方：lsof -nP -iTCP:${new URL(url).port} -sTCP:LISTEN`,
      "注意 IPv4 与 IPv6 可以是两个不同的监听者，curl 127.0.0.1 与 [::1] 未必是同一个服务。",
    ].join("\n"),
  );
}
