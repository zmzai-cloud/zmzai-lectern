import { hostFetch } from "@/lib/m2a-host";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  const res = await hostFetch("/v1/commands/session", { method: "POST" });
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json; charset=utf-8" } });
}
