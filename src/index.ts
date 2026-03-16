#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

// ── Load env from file ──────────────────────────────────────

function loadEnvFile(path: string): void {
  try {
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).replace(/^export\s+/, "").trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // File not found is fine — fall through to env vars
  }
}

// Load from .env.shared, then project-local customeros.env as fallbacks
loadEnvFile(join(homedir(), "Documents", ".env.shared"));
loadEnvFile(join(homedir(), "Documents", "customer-success-platform", "customeros.env"));

// ── Config ──────────────────────────────────────────────────

const SUPABASE_URL = process.env.CUSTOMEROS_SUPABASE_URL;
const SUPABASE_KEY = process.env.CUSTOMEROS_SUPABASE_ANON_KEY;
const BERGEN_EMPLOYEE_ID = process.env.CUSTOMEROS_BERGEN_EMPLOYEE_ID;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    "Missing env: CUSTOMEROS_SUPABASE_URL, CUSTOMEROS_SUPABASE_ANON_KEY\n" +
    "Set them in ~/Documents/.env.shared or pass as environment variables."
  );
  process.exit(1);
}

const BASE = `${SUPABASE_URL}/rest/v1`;

// ── HTTP helpers ────────────────────────────────────────────

const headers = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Accept-Profile": "public",
  "Content-Type": "application/json",
};

async function supaGet<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${BASE}/${path}`, { headers });
  if (!res.ok) throw new Error(`Supabase GET ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

async function supaPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}/${path}`, {
    method: "POST",
    headers: { ...headers, Prefer: "return=representation" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase POST ${path}: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

async function supaPatch<T = unknown>(
  path: string,
  body: unknown
): Promise<T> {
  const res = await fetch(`${BASE}/${path}`, {
    method: "PATCH",
    headers: { ...headers, Prefer: "return=representation" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase PATCH ${path}: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

// ── Resolve helpers ─────────────────────────────────────────

interface Account {
  id: string;
  name: string;
  status?: string;
}

interface TeamMember {
  id: string;
  name: string;
  role?: string;
  team?: string;
}

interface Ticket {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  status?: string;
  template?: string;
  account_id?: string;
  account_name?: string;
  employee_id?: string;
  employee_name?: string;
  deadline?: string;
  created_at?: string;
  updated_at?: string;
  custom_fields?: Record<string, string>;
  created_by_name?: string;
  csm_name?: string;
}

interface ClientNote {
  id: string;
  content: string;
  author_name?: string;
  created_at: string;
}

interface TicketTemplate {
  slug: string;
  label: string;
  description?: string;
  default_employee_name?: string;
  default_deadline_days?: number;
  fields?: Array<{ key: string }>;
}

async function resolveAccount(search: string): Promise<Account> {
  const data = await supaGet<Account[]>(
    `accounts?select=id,name&name=ilike.*${encodeURIComponent(search)}*&limit=1`
  );
  if (!data.length) throw new Error(`Account not found: ${search}`);
  return data[0];
}

async function resolveMember(search: string): Promise<TeamMember> {
  const data = await supaGet<TeamMember[]>(
    `team_members?select=id,name&name=ilike.*${encodeURIComponent(search)}*`
  );
  if (!data.length) throw new Error(`Team member not found: ${search}`);
  // Pick longest name (full name over alias)
  data.sort((a, b) => b.name.length - a.name.length);
  return data[0];
}

async function resolveTemplateDefaults(
  slug: string
): Promise<{ employee_name: string; deadline_days: number | null }> {
  const data = await supaGet<TicketTemplate[]>(
    `ticket_templates?select=default_employee_name,default_deadline_days&slug=eq.${slug}`
  );
  if (!data.length) return { employee_name: "", deadline_days: null };
  return {
    employee_name: data[0].default_employee_name ?? "",
    deadline_days: data[0].default_deadline_days ?? null,
  };
}

// ── Markdown → HTML ─────────────────────────────────────────

function markdownToHtml(text: string): string {
  const lines = text.trim().split("\n");
  const parts: string[] = [];
  let inList = false;
  let listType: "ol" | "ul" = "ul";

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      if (inList) {
        parts.push(`</${listType}>`);
        inList = false;
      }
      continue;
    }

    if (line.startsWith("## ")) {
      if (inList) {
        parts.push(`</${listType}>`);
        inList = false;
      }
      parts.push(`<h2>${line.slice(3)}</h2>`);
    } else if (/^\d+\.\s/.test(line)) {
      if (!inList) {
        listType = "ol";
        parts.push("<ol>");
        inList = true;
      }
      parts.push(`<li>${line.replace(/^\d+\.\s+/, "")}</li>`);
    } else if (line.startsWith("- ")) {
      if (!inList) {
        listType = "ul";
        parts.push("<ul>");
        inList = true;
      }
      parts.push(`<li>${line.slice(2)}</li>`);
    } else {
      if (inList) {
        parts.push(`</${listType}>`);
        inList = false;
      }
      const bolded = line.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      parts.push(`<p>${bolded}</p>`);
    }
  }

  if (inList) parts.push(`</${listType}>`);
  return parts.join("\n");
}

// ── Date helpers ────────────────────────────────────────────

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Formatters ──────────────────────────────────────────────

function formatTicketRow(t: Ticket): string {
  const dl = t.deadline ?? "";
  const tmpl = t.template ?? "";
  const emp = t.employee_name ?? "";
  const acct = t.account_name ?? "";
  return `${t.identifier.padEnd(8)} ${tmpl.padEnd(12)} ${(t.status ?? "").padEnd(12)} ${acct.padEnd(25)} ${emp.padEnd(25)} ${dl.padEnd(12)} ${t.title}`;
}

// ── MCP Server ──────────────────────────────────────────────

const server = new McpServer({
  name: "customeros",
  version: "1.0.0",
});

// ── Tools ───────────────────────────────────────────────────

server.tool("list_accounts", "List all CustomerOS accounts with status", {}, async () => {
  const data = await supaGet<Account[]>(
    "accounts?select=id,name,status&order=name.asc"
  );
  const lines = data.map(
    (a) => `${a.name.padEnd(40)} ${a.status ?? ""}`
  );
  lines.push("", `${data.length} accounts`);
  return { content: [{ type: "text", text: lines.join("\n") }] };
});

server.tool(
  "get_account",
  "Find account by name (fuzzy search)",
  { name: z.string().describe("Account name to search for") },
  async ({ name }) => {
    const data = await supaGet<Account[]>(
      `accounts?select=*&name=ilike.*${encodeURIComponent(name)}*&limit=5`
    );
    if (!data.length) return { content: [{ type: "text", text: "No accounts found" }] };
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

server.tool("list_team", "List all team members with roles", {}, async () => {
  const data = await supaGet<TeamMember[]>(
    "team_members?select=id,name,role,team&order=team.asc,name.asc"
  );
  const lines = data.map(
    (m) =>
      `${m.name.padEnd(35)} ${(m.team ?? "").padEnd(20)} ${m.role ?? ""}`
  );
  lines.push("", `${data.length} team members`);
  return { content: [{ type: "text", text: lines.join("\n") }] };
});

server.tool(
  "list_tickets",
  "List tickets, optionally filtered by status (todo, in_progress, in_review, done, backlog, cancelled)",
  {
    status: z
      .enum(["todo", "in_progress", "in_review", "done", "backlog", "cancelled"])
      .optional()
      .describe("Filter by ticket status"),
  },
  async ({ status }) => {
    const filter = status ? `&status=eq.${status}` : "";
    const data = await supaGet<Ticket[]>(
      `tickets?select=identifier,title,template,status,account_name,employee_name,deadline&order=deadline.asc.nullslast,created_at.desc${filter}`
    );
    const lines = data.map(formatTicketRow);
    lines.push("", `${data.length} tickets`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "get_my_tickets",
  "List Bergen's open tickets (not done)",
  {},
  async () => {
    if (!BERGEN_EMPLOYEE_ID) {
      return {
        content: [{ type: "text", text: "CUSTOMEROS_BERGEN_EMPLOYEE_ID not set" }],
      };
    }
    const data = await supaGet<Ticket[]>(
      `tickets?select=identifier,title,template,status,account_name,deadline&employee_id=eq.${BERGEN_EMPLOYEE_ID}&status=neq.done&order=deadline.asc.nullslast,created_at.desc`
    );
    if (!data.length)
      return { content: [{ type: "text", text: "No open tickets" }] };
    const lines = data.map((t) => {
      const dl = t.deadline ?? "";
      const tmpl = t.template ?? "";
      return `${t.identifier.padEnd(8)} ${tmpl.padEnd(12)} ${(t.status ?? "").padEnd(12)} ${(t.account_name ?? "").padEnd(25)} ${dl.padEnd(12)} ${t.title}`;
    });
    lines.push("", `${data.length} open tickets`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "get_ticket",
  "Get full details for a single ticket by ID (TK-nnn) or UUID",
  { id: z.string().describe("Ticket identifier (TK-nnn) or UUID") },
  async ({ id }) => {
    const filter = id.startsWith("TK-")
      ? `identifier=eq.${id}`
      : `id=eq.${id}`;
    const data = await supaGet<Ticket[]>(`tickets?select=*&${filter}`);
    if (!data.length)
      return { content: [{ type: "text", text: "Ticket not found" }] };
    return {
      content: [{ type: "text", text: JSON.stringify(data[0], null, 2) }],
    };
  }
);

server.tool(
  "list_notes",
  "List client notes for an account",
  { account: z.string().describe("Account name (fuzzy search)") },
  async ({ account }) => {
    const acct = await resolveAccount(account);
    const data = await supaGet<ClientNote[]>(
      `client_notes?select=*&account_id=eq.${acct.id}&order=created_at.desc`
    );
    if (!data.length)
      return { content: [{ type: "text", text: "No notes found" }] };
    const lines = data.map((n) => {
      const date = n.created_at.slice(0, 10);
      return `[${date}] ${n.author_name ?? ""}: ${n.content}`;
    });
    lines.push("", `${data.length} notes`);
    return { content: [{ type: "text", text: lines.join("\n\n") }] };
  }
);

server.tool(
  "list_templates",
  "List ticket templates with fields and defaults",
  {},
  async () => {
    const data = await supaGet<TicketTemplate[]>(
      "ticket_templates?select=slug,label,description,default_employee_name,default_deadline_days,fields&order=sort_order.asc"
    );
    const lines = data.map((t) => {
      const assignee = t.default_employee_name ?? "unassigned";
      const days = t.default_deadline_days ?? "-";
      const fields = (t.fields ?? []).map((f) => f.key).join(", ");
      let line = `${t.slug.padEnd(20)} ${t.label.padEnd(22)} assignee: ${assignee.padEnd(30)} deadline: ${days}d`;
      if (t.description) line += `\n${"".padEnd(20)} ${t.description}`;
      if (fields) line += `\n${"".padEnd(20)} fields: ${fields}`;
      return line;
    });
    return { content: [{ type: "text", text: lines.join("\n\n") }] };
  }
);

server.tool(
  "create_ticket",
  "Create a new CustomerOS ticket",
  {
    template: z
      .enum([
        "onboarding",
        "l1",
        "l2",
        "l4",
        "email",
        "phone",
        "client_digest",
        "customeros_feedback",
        "request_list",
        "l1_test",
      ])
      .describe("Ticket template"),
    account: z.string().describe("Account name (fuzzy search)"),
    title: z.string().describe("Ticket title"),
    assignee: z
      .string()
      .optional()
      .describe("Assignee name (fuzzy search). Uses template default if omitted."),
    deadline: z
      .string()
      .optional()
      .describe("Deadline as YYYY-MM-DD. Uses template default if omitted."),
    description: z
      .string()
      .optional()
      .describe("Description (supports markdown: ## headers, - lists, **bold**)"),
    custom_fields: z
      .record(z.string(), z.string())
      .optional()
      .describe("Custom fields as key-value pairs (e.g. l4_list URL)"),
  },
  async ({ template, account, title, assignee, deadline, description, custom_fields }) => {
    const acct = await resolveAccount(account);

    // Resolve assignee
    let employeeId: string | undefined;
    let employeeName: string | undefined;
    if (assignee) {
      const member = await resolveMember(assignee);
      employeeId = member.id;
      employeeName = member.name;
    } else {
      const defaults = await resolveTemplateDefaults(template);
      if (defaults.employee_name) {
        const member = await resolveMember(defaults.employee_name);
        employeeId = member.id;
        employeeName = member.name;
      }
    }

    // Resolve deadline
    let resolvedDeadline = deadline;
    if (!resolvedDeadline) {
      const defaults = await resolveTemplateDefaults(template);
      if (defaults.deadline_days) {
        resolvedDeadline = addDays(defaults.deadline_days);
      }
    }

    const payload: Record<string, unknown> = {
      title,
      template,
      status: "todo",
      account_id: acct.id,
      account_name: acct.name,
    };

    if (employeeId) {
      payload.employee_id = employeeId;
      payload.employee_name = employeeName;
    }
    if (resolvedDeadline) payload.deadline = resolvedDeadline;
    if (description) payload.description = markdownToHtml(description);
    if (custom_fields) payload.custom_fields = custom_fields;

    const result = await supaPost<Ticket[]>("tickets", payload);
    const t = Array.isArray(result) ? result[0] : result;

    const lines = [
      `Created: ${t.identifier} — ${t.title}`,
      `  Account:    ${t.account_name ?? ""}`,
      `  Assignee:   ${t.employee_name ?? "unassigned"}`,
      `  Template:   ${t.template ?? ""}`,
      `  Deadline:   ${t.deadline ?? "none"}`,
      `  Status:     ${t.status ?? ""}`,
    ];
    if (t.description) lines.push(`  Description: ${t.description}`);
    if (t.custom_fields) {
      for (const [k, v] of Object.entries(t.custom_fields)) {
        lines.push(`  ${k}: ${v}`);
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "update_ticket",
  "Update an existing CustomerOS ticket",
  {
    ticket: z.string().describe("Ticket identifier (TK-nnn) or UUID"),
    status: z
      .enum(["todo", "in_progress", "in_review", "done", "backlog", "cancelled"])
      .optional()
      .describe("New status"),
    template: z.string().optional().describe("New template slug (e.g. request_list, l4)"),
    assignee: z.string().optional().describe("New assignee (fuzzy search)"),
    deadline: z.string().optional().describe("New deadline (YYYY-MM-DD)"),
    title: z.string().optional().describe("New title"),
    description: z
      .string()
      .optional()
      .describe("New description (supports markdown)"),
  },
  async ({ ticket, status, template, assignee, deadline, title, description }) => {
    const filter = ticket.startsWith("TK-")
      ? `identifier=eq.${ticket}`
      : `id=eq.${ticket}`;

    const payload: Record<string, unknown> = {};

    if (assignee) {
      const member = await resolveMember(assignee);
      payload.employee_id = member.id;
      payload.employee_name = member.name;
    }
    if (status) payload.status = status;
    if (template) payload.template = template;
    if (deadline) payload.deadline = deadline;
    if (title) payload.title = title;
    if (description) payload.description = markdownToHtml(description);

    if (!Object.keys(payload).length) {
      return { content: [{ type: "text", text: "No updates specified" }] };
    }

    const result = await supaPatch<Ticket[]>(`tickets?${filter}`, payload);
    const t = Array.isArray(result) ? result[0] : result;

    const lines = [`Updated: ${t.identifier} — ${t.title}`];
    if (t.employee_name) lines.push(`  Assignee:   ${t.employee_name}`);
    if (t.status) lines.push(`  Status:     ${t.status}`);
    if (t.deadline) lines.push(`  Deadline:   ${t.deadline}`);

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ── Start ───────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
