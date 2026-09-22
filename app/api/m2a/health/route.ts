import { hostFetch } from "@/lib/m2a-host";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const res = await hostFetch("/health");
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json; charset=utf-8" } });
}
