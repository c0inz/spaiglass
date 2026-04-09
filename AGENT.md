# Project: Spyglass - Browser-Based Multi-VM Claude Interface

## What We Are Building

A self-hosted, browser-accessible web application that provides a chat interface
to Claude CLI instances running on Ubuntu VMs. The user accesses this from any
device, anywhere, via browser only - no terminal, no SSH, no client software.

## The Problem It Solves

The user manages 20+ software projects across multiple Ubuntu VMs. Each VM runs
a specialised Claude CLI with a defined role (designer, security auditor, backend
developer, etc.). The user needs to:

- Chat with any of these Claude instances from a laptop or phone, from anywhere
- Upload images into the chat for Claude to analyse
- Receive files (screenshots, `.md` documents) back from Claude in the chat
- Browse the project directory on the VM and open `.md` files to read and edit
- Maintain separate persistent chat histories per project
- Never touch a terminal for day-to-day use

## What The User Does

The user is a product owner / architect. They:
- Write `.md` files that describe what they want built
- Chat with Claude to direct work
- Review outputs
- Upload reference images or screenshots for Claude to work from

The user does not write code, run commands, or edit anything except `.md` files.

## Base Project

We forked and renamed: **https://github.com/c0inz/spyglass** (forked from sugyan/claude-code-webui)

- MIT licensed, actively maintained
- React 19 frontend, Hono backend, NDJSON streaming
- Already handles: Claude CLI process spawning, project selection, chat history,
  session resumption, dark/light theme, mobile responsive design
- Runs backend on the VM, frontend served to browser - correct architecture

## VM Role Model

Each VM runs one Claude CLI installation with a defined role:

```
VM: designer-01    → Claude configured as UI/UX designer
VM: security-01    → Claude configured as security auditor
VM: backend-01     → Claude configured as backend developer
VM: devops-01      → Claude configured as DevOps / infrastructure engineer
```

One browser tab per VM. Each tab is a completely isolated Claude session with
its own role, its own project context, and its own chat history.

A single project can use multiple VMs simultaneously - e.g. the designer VM and
the security VM both pointed at the same project directory (via shared mount or
git clone on each).

## Networking

- All VMs are on a Tailscale private mesh network
- User's laptops and phone are also on Tailscale
- The WebUI backend on each VM is accessible at `http://<vm-tailscale-ip>:8080`
- Nothing is exposed to the public internet
- Guacamole provides browser-based full desktop access to each VM when needed
