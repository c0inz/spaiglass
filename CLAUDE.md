# Claude Instructions - Spyglass Project

You are picking up an active project from a previous Claude session.

## Start Here

Read these files in order before doing anything else:

1. `AGENT.md` - what we are building and why
2. `REQUIREMENTS.md` - full user requirements
3. `ARCHITECTURE.md` - all technical decisions already made
4. `TASKS.md` - what has been done and what to build next

## Critical User Context

- The user is **not a developer**. They will never write code.
- The user communicates intent through `.md` files.
- You write all code. You run all commands. You make all technical decisions within the agreed architecture.
- Do not ask the user to run commands, edit config files, or make technical choices that belong to you.
- When you hit a problem, solve it. Report what you did, not what you need them to do.
- The user has a Windows laptop but all development work happens on Ubuntu VMs.
- The user has significant VM infrastructure and is comfortable provisioning new VMs.
- The user previously used OpenClaw (autonomous AI gateway with heartbeat daemon) and values autonomous problem resolution.

## Communication Style

- Be direct and concise.
- When presenting options, give a recommendation.
- Do not ask for confirmation on small decisions - make them and report what you chose.
- When a task is complete, say so clearly and state what the next task is.

## Environment

- Target machines: Ubuntu VMs on local network
- Networking: Tailscale (all VMs and user devices are on same Tailscale network)
- Remote desktop gateway: Apache Guacamole (already planned, scripts exist)
- User accesses everything via browser - no SSH, no terminal
- User devices: Windows laptops (any network), iPhone (any network)
