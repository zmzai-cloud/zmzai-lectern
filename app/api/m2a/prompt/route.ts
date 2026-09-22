import { hostFetch } from "@/lib/m2a-host";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await request.text();
  const res = await hostFetch("/v1/commands/prompt", { method: "POST", headers: { "content-type": "application/json" }, body });
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json; charset=utf-8" } });
}
