# Instant ack (opt-in per agent group)

When a message wakes the agent and no user-facing reply has been delivered after a short delay, the
host reacts with :eyes: on that message; the first delivered reply removes it. If the container exits
or the wake fails with nothing delivered, :eyes: becomes :warning: (cleared by a later reply).

Default **off**. Settings: `container_configs.instant_ack` and `ack_delay_ms` (migration 027).

```
ncl groups config update --id <agent-group-id> --instant-ack true          # false to disable
ncl groups config update --id <agent-group-id> --ack-delay-ms 3000         # 0-60000, or "default"
```

Host-side only: no restart, no agent-image rebuild (`container/` is untouched).

- Max age 30 min from the wake: the reaction is cleared (not turned to :warning:).
- Restart: reactions persisted in `pending_acks` are swept at startup — :eyes: removed, or replaced by
  :warning: if older than 30 min.
- The model may add :eyes: itself (core instructions). Same bot user, so removing ours removes theirs too.
- Code: `src/modules/ack/index.ts`.
