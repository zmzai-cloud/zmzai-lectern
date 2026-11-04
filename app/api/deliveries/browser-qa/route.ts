import { hostGateway } from "@/lib/host-gateway";
import { handleBrowserQa } from "@/lib/browser-qa-service";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request) {
  const response = await hostGateway(request);
  return response ?? handleBrowserQa(request);
}
