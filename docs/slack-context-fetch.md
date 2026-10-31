# Slack context fetch (opt-in per agent group)

When an agent is engaged by a **mention** in a Slack channel or thread, the host can fetch the
surrounding Slack history and hand it to the agent as one background block, so it sees messages
it never received (a thread root older than the agent, messages sent while NanoClaw was down,
more than `max_messages_per_prompt`, or recent top-level channel chatter).

Default **off**. Setting: `container_configs.slack_context_fetch` (migration 026), per agent group.

## Enable / disable

```
ncl groups config update --id <agent-group-id> --slack-context-fetch true     # false to disable
ncl groups config get --id <agent-group-id>                                   # shows slack_context_fetch
```

Host-side only: it is read by the router on each mention and never reaches `container.json`, so
no restart and no agent-image rebuild is needed. (The `config update` command is
approval-gated like the other config writes.) Without the CLI: `UPDATE container_configs SET
slack_context_fetch = 1 WHERE agent_group_id = '<id>';` on the central DB.

## Behaviour

- Trigger: a waking message with a platform-confirmed mention in a group/channel (not DMs). Untagged
  messages never fetch and never wake; sticky follow-ups without a mention do not re-fetch.
- Thread reply: `conversations.replies` — the root plus the newest replies before the mention.
  Top-level mention: `conversations.history` — the last 30 messages, at most 24 h old.
- Budget: ~50 messages / ~8k tokens (chars/4), 2000 chars per message. Over budget keeps the root
  and the newest and inserts `(N starších zpráv vynecháno)`.
- Delivered as one `trigger=0` row, `<slack_context source="thread|channel">`, written immediately
  before the waking message. (The container's formatter XML-escapes message text, so the agent sees
  the tags escaped; this also stops message text from forging a closing tag.)
- Names: the Chat SDK adapter resolves `users.info` display names (cached in its state store); the
  agent's own messages are marked `you (<name>)`.
- Dedupe: fetched messages whose Slack ts is already in the session (accumulated rows, earlier turns,
  or an earlier context block) are dropped from the fetched set; stored rows are never modified.
- Fail soft: any Slack error (`missing_scope`, `not_in_channel`, rate limit, ...) or a 3 s timeout logs
  a warning (`Conversation context fetch failed`) and delivery proceeds as without the feature.
- Known limit (Chat SDK / Slack API): in threads over ~200 replies the newest-first window is taken
  from the oldest 200.

## Slack scopes (bot token; reinstall the app after adding)

`channels:history` (public channels), `groups:history` (private channels), `users:read`
(display names). The bot must be a member of the channel (`not_in_channel` otherwise).
