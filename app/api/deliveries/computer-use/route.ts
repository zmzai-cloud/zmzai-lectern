import { hostGateway } from "@/lib/host-gateway";
import { handleComputerUse } from "@/lib/computer-use-service";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request) {
  const response = await hostGateway(request);
  return response ?? handleComputerUse(request);
}
