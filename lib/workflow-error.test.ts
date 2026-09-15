import { expect, it } from "vitest";
import { NextResponse } from "next/server";
import { rethrowWorkflowError, withWorkflowErrors, WorkflowError } from "./workflow-error";

it("passes through NextResponse and streamed Response without consuming bodies", async () => {
  for (const response of [NextResponse.json({ ok: true }), new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: test\n\n")); c.close(); } }), { headers: { "content-type": "text/event-stream" } })]) {
    expect(await withWorkflowErrors(async () => response)()).toBe(response);
    expect(response.bodyUsed).toBe(false);
  }
});
it("preserves structured domain errors through inner catch blocks", async () => {
  const response = await withWorkflowErrors(async () => {
    try { throw new WorkflowError("RECOVERY_REQUIRED", "restore workspace", 409, true); }
    catch (error) { rethrowWorkflowError(error); return Response.json({ error: "fallback" }); }
  })();
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "restore workspace", detail: { code: "RECOVERY_REQUIRED", message: "restore workspace", retryable: true, requestId: expect.any(String) } });
});
it("leaves unexpected exceptions for framework error handling", async () => {
  const error = new Error("unexpected");
  await expect(withWorkflowErrors(async () => { throw error; })()).rejects.toBe(error);
});
