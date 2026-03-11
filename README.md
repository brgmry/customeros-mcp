# CustomerOS MCP Server

A local [Model Context Protocol](https://modelcontextprotocol.io) server for managing CustomerOS — tickets, accounts, team members, and notes — backed by Supabase.

Built for use with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) but works with any MCP client.

## Tools

| Tool | Description |
|------|-------------|
| `list_accounts` | List all accounts with status |
| `get_account` | Find account by name (fuzzy search) |
| `list_team` | List team members with roles |
| `list_tickets` | List tickets, optionally filtered by status |
| `get_my_tickets` | List your open tickets |
| `get_ticket` | Get full ticket details by ID |
| `list_notes` | List client notes for an account |
| `list_templates` | List ticket templates with defaults |
| `create_ticket` | Create a new ticket with template, account, assignee |
| `update_ticket` | Update ticket status, assignee, deadline, description |

## Setup

### 1. Install

```bash
git clone https://github.com/throxy-labs/customeros-mcp.git
cd customeros-mcp
bun install   # or npm install
bun run build # or npm run build
```

### 2. Environment Variables

Set these in your shell or `.env`:

```bash
CUSTOMEROS_SUPABASE_URL=https://your-project.supabase.co
CUSTOMEROS_SUPABASE_ANON_KEY=your-anon-key
CUSTOMEROS_BERGEN_EMPLOYEE_ID=your-employee-uuid  # optional, for get_my_tickets
```

### 3. Configure MCP Client

**Claude Code** — add to your `.mcp.json` or Claude Code settings:

```json
{
  "mcpServers": {
    "customeros": {
      "command": "node",
      "args": ["/path/to/customeros-mcp/dist/index.js"],
      "env": {
        "CUSTOMEROS_SUPABASE_URL": "https://your-project.supabase.co",
        "CUSTOMEROS_SUPABASE_ANON_KEY": "your-anon-key",
        "CUSTOMEROS_BERGEN_EMPLOYEE_ID": "your-employee-uuid"
      }
    }
  }
}
```

## Usage Examples

Once connected, your MCP client can call tools like:

```
list_tickets(status: "todo")
create_ticket(template: "email", account: "Acme", title: "March Campaign", assignee: "bergen")
update_ticket(ticket: "TK-320", status: "backlog")
get_ticket(id: "TK-492")
```

Ticket descriptions support markdown (## headers, - lists, **bold**) and are automatically converted to HTML for the CustomerOS UI.

## Supabase Schema

Expects these tables in your Supabase project:

- `accounts` — id, name, status
- `team_members` — id, name, role, team
- `tickets` — id, identifier, title, description, status, template, account_id, account_name, employee_id, employee_name, deadline, custom_fields, created_at
- `client_notes` — id, content, author_name, account_id, created_at
- `ticket_templates` — slug, label, description, default_employee_name, default_deadline_days, fields, sort_order

## License

MIT
