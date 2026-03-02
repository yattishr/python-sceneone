import {
  CopilotRuntime,
  ExperimentalEmptyAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime";
import { HttpAgent } from "@ag-ui/client";
import { NextRequest } from "next/server";

const serviceAdapter = new ExperimentalEmptyAdapter();

function buildAgentUrl(): string {
  const explicit = process.env.COPILOTKIT_AGENT_URL?.trim();
  if (explicit) {
    return explicit;
  }

  const backendBase = process.env.NEXT_PUBLIC_BACKEND_URL?.trim() || "http://localhost:8000";
  return `${backendBase.replace(/\/+$/, "")}/copilotkit`;
}

const AGENT_URL = buildAgentUrl();

const runtime = new CopilotRuntime({
  agents: {
    adk_agent: new HttpAgent({ url: AGENT_URL }),
  }
});

export const POST = async (req: NextRequest) => {
  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    serviceAdapter,
    endpoint: "/api/copilotkit",
  });

  return handleRequest(req);
};
