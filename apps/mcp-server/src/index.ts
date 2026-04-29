import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BASE_URL = process.env.AEGIS_API_BASE_URL ?? "http://localhost:4000";

async function callAegis(path: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

function formatResult(response: unknown): string {
  const r = response as Record<string, unknown>;
  const data = r?.data as Record<string, unknown> | undefined;
  const decision = data?.decision as string | undefined;

  const json = JSON.stringify(response, null, 2);

  if (decision === "approval_required") {
    return `Approval required. Stop and wait for user approval. Do not retry or bypass.\n\n${json}`;
  }
  if (decision === "block") {
    return `Blocked by collar policy. Do not bypass.\n\n${json}`;
  }
  if (
    (data?.receipt_id || data?.runner_task_id) &&
    (decision === "allow" || !decision)
  ) {
    return `Aegis Runner handled the sensitive step. Secrets were not exposed to this agent.\n\n${json}`;
  }
  return json;
}

const server = new Server(
  { name: "aegis-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "aegis_create_session",
      description:
        "Open a protected Playwright browser session under an Aegis Pass. Each session gets an isolated Chromium context enforced by the collar attached to the pass.",
      inputSchema: {
        type: "object",
        properties: {
          agent_pass_token: {
            type: "string",
            description: "Token from the Aegis Pass. Treat as a password.",
          },
          purpose: {
            type: "string",
            description: "Human-readable reason for this session.",
          },
          requested_collar_id: {
            type: "string",
            description: "Override the pass default collar.",
          },
          mode: {
            type: "string",
            enum: ["headless", "visible"],
            description: "Browser mode. Defaults to headless.",
          },
        },
        required: ["agent_pass_token"],
      },
    },
    {
      name: "aegis_navigate",
      description:
        "Navigate the protected browser to a URL. Navigation is always allowed — it is not a sensitive action.",
      inputSchema: {
        type: "object",
        properties: {
          agent_pass_token: { type: "string" },
          session_id: { type: "string" },
          url: { type: "string", description: "URL to navigate to." },
        },
        required: ["agent_pass_token", "session_id", "url"],
      },
    },
    {
      name: "aegis_read_page",
      description:
        "Return the page title and a text preview of the current page.",
      inputSchema: {
        type: "object",
        properties: {
          agent_pass_token: { type: "string" },
          session_id: { type: "string" },
        },
        required: ["agent_pass_token", "session_id"],
      },
    },
    {
      name: "aegis_click",
      description:
        "Click a browser element. Aegis inspects the element, evaluates the collar, and either executes the click, pauses for approval, or blocks.",
      inputSchema: {
        type: "object",
        properties: {
          agent_pass_token: { type: "string" },
          session_id: { type: "string" },
          target_type: {
            type: "string",
            enum: ["text", "selector"],
            description: "Match by visible text or CSS selector.",
          },
          target_value: {
            type: "string",
            description: "The text or selector to match.",
          },
        },
        required: ["agent_pass_token", "session_id", "target_type", "target_value"],
      },
    },
    {
      name: "aegis_type",
      description:
        "Type a value into a browser input. Aegis inspects the field before allowing. Typed values are never stored in receipts.",
      inputSchema: {
        type: "object",
        properties: {
          agent_pass_token: { type: "string" },
          session_id: { type: "string" },
          target_type: {
            type: "string",
            enum: ["text", "selector"],
            description: "Match by visible text or CSS selector.",
          },
          target_value: {
            type: "string",
            description: "The text or selector to match.",
          },
          value: {
            type: "string",
            description:
              "The value to type. Do not pass card numbers, CVV, passwords, or identity data — Aegis Runner handles those from the vault.",
          },
        },
        required: ["agent_pass_token", "session_id", "target_type", "target_value", "value"],
      },
    },
    {
      name: "aegis_screenshot",
      description: "Return a base64-encoded PNG of the current page.",
      inputSchema: {
        type: "object",
        properties: {
          agent_pass_token: { type: "string" },
          session_id: { type: "string" },
        },
        required: ["agent_pass_token", "session_id"],
      },
    },
    {
      name: "aegis_request_capability",
      description:
        "Ask Aegis whether a named action is permitted before attempting it. Use this to check collar policy without triggering a real browser action.",
      inputSchema: {
        type: "object",
        properties: {
          agent_pass_token: { type: "string" },
          session_id: { type: "string" },
          action_type: {
            type: "string",
            description: "The action to check, e.g. 'purchase', 'login'.",
          },
          domain: {
            type: "string",
            description: "The target domain, e.g. 'example-store.com'.",
          },
          context: {
            type: "object",
            description: "Optional context passed to the policy engine.",
          },
        },
        required: ["agent_pass_token", "session_id", "action_type"],
      },
    },
    {
      name: "aegis_close_session",
      description:
        "Close the protected browser session and its Playwright context. Call when done or on error.",
      inputSchema: {
        type: "object",
        properties: {
          agent_pass_token: { type: "string" },
          session_id: { type: "string" },
        },
        required: ["agent_pass_token", "session_id"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  let response: unknown;

  switch (name) {
    case "aegis_create_session": {
      const body: Record<string, unknown> = {
        agent_pass_token: a.agent_pass_token,
      };
      if (a.purpose !== undefined) body.purpose = a.purpose;
      if (a.requested_collar_id !== undefined) body.requested_collar_id = a.requested_collar_id;
      if (a.mode !== undefined) body.mode = a.mode;
      response = await callAegis("/api/agent/create-session", body);
      break;
    }

    case "aegis_navigate": {
      response = await callAegis(
        `/api/agent/session/${a.session_id}/navigate`,
        { agent_pass_token: a.agent_pass_token, url: a.url }
      );
      break;
    }

    case "aegis_read_page": {
      response = await callAegis(
        `/api/agent/session/${a.session_id}/read-page`,
        { agent_pass_token: a.agent_pass_token }
      );
      break;
    }

    case "aegis_click": {
      response = await callAegis(
        `/api/agent/session/${a.session_id}/click`,
        {
          agent_pass_token: a.agent_pass_token,
          target: { type: a.target_type, value: a.target_value },
        }
      );
      break;
    }

    case "aegis_type": {
      response = await callAegis(
        `/api/agent/session/${a.session_id}/type`,
        {
          agent_pass_token: a.agent_pass_token,
          target: { type: a.target_type, value: a.target_value },
          value: a.value,
        }
      );
      break;
    }

    case "aegis_screenshot": {
      response = await callAegis(
        `/api/agent/session/${a.session_id}/screenshot`,
        { agent_pass_token: a.agent_pass_token }
      );
      break;
    }

    case "aegis_request_capability": {
      const body: Record<string, unknown> = {
        agent_pass_token: a.agent_pass_token,
        action_type: a.action_type,
      };
      if (a.domain !== undefined) body.domain = a.domain;
      if (a.context !== undefined) body.context = a.context;
      response = await callAegis(
        `/api/agent/session/${a.session_id}/request-capability`,
        body
      );
      break;
    }

    case "aegis_close_session": {
      response = await callAegis(
        `/api/agent/session/${a.session_id}/close`,
        { agent_pass_token: a.agent_pass_token }
      );
      break;
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }

  return {
    content: [{ type: "text", text: formatResult(response) }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
