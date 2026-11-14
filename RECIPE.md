# Kanban

A task board for Herdr. Cards move from STAGING to WORKING to DONE as agents work.

## Build

Create a top panel with three task columns: STAGING, WORKING, and DONE. STAGING
cards can be created and edited. A person chooses an available agent to pick up
a card; the agent gets the task and relevant completed results. Keep the board
visible while the agent works, and open its pane only on a double-click. Move
successful tasks directly to DONE with their result and elapsed time. Return
failed or aborted tasks to STAGING.

Add a settings button beside the new-card action. It detects installed agents
and lets the person choose which ones appear in the pickup list.

Use a compact, dark green palette and native Herdr mod controls. The board
allocates two card widths to STAGING, one to WORKING, and three to DONE.
