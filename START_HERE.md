# How To Hand This Off To A Fresh Claude Session

## What This Directory Contains

A complete project briefing generated from a planning session. A fresh Claude CLI
install can pick up this work without any verbal explanation from you.

## Files In This Directory

| File | Purpose |
|---|---|
| `CLAUDE.md` | Instructions for Claude - read this first |
| `AGENT.md` | What we are building and why |
| `REQUIREMENTS.md` | Full user requirements |
| `ARCHITECTURE.md` | All technical decisions already made |
| `TASKS.md` | Phased task list with current status |
| `START_HERE.md` | This file |

## How To Start A New Claude Session On Your VM

1. Copy this directory to your Ubuntu VM:
   ```
   # From your Windows machine, use WinSCP or run:
   scp -r C:\Users\johnt\claude-webui-project user@<vm-tailscale-ip>:~/
   ```
   Or if you have the files on a USB / GitHub, just get them onto the VM.

2. SSH into the VM (or use Guacamole terminal) and navigate to the directory:
   ```bash
   cd ~/claude-webui-project
   claude
   ```

3. Claude Code will automatically read `CLAUDE.md` from the working directory.

4. Say only this to start:
   > "Read all the .md files in this directory then begin Phase 1 of TASKS.md"

5. Claude will read the full context and begin working without further explanation.

## How To Resume After An Interruption

If a session was interrupted mid-task, update `TASKS.md` to mark which tasks
completed before the interruption, then start a new session and say:
   > "Read all the .md files in this directory then continue from where TASKS.md shows we left off"

## Updating Requirements

If you want to change something, edit `REQUIREMENTS.md` or `ARCHITECTURE.md`
directly, then tell Claude:
   > "I have updated REQUIREMENTS.md - re-read it and adjust the plan in TASKS.md accordingly"
