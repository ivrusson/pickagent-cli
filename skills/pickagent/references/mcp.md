# pickagent MCP (public)

Endpoint: `https://pickagent.dev/api/mcp` (stateless HTTP, read-only public tools).

## Claude Code

```bash
claude mcp add --transport http pickagent https://pickagent.dev/api/mcp
```

Use `--scope user` if you want it in every project. Restart or reload MCP if the client does not see the server.

## Codex

```bash
codex mcp add pickagent --url https://pickagent.dev/api/mcp
```

Run `codex mcp list` to confirm `pickagent` appears.

## Public tools (4)

| Tool               | Purpose                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `simulate_profile` | Input: full `pickagent.profile/v1` JSON. Output: deterministic verdict (ranking, blocks, EUR cost, sources). |
| `list_plans`       | All catalog plans with prices, limits, and source metadata.                                                  |
| `get_plan`         | Input: `plan_id` (e.g. `claude-pro`).                                                                        |
| `search_tools`     | Input: `query`, optional `limit`. Directory tools and compatibility.                                         |

All prices and limits must come from tool results — do not guess.

OAuth-backed private tools (saved subscriptions and verdicts) are coming soon; they are not documented here.
