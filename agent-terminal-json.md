# Agents.INK.md

### WebSocket Communication Protocol: The "Ink" Layer Contract

All bidirectional communication between the `spaiglass` React frontend and the remote Host Backend MUST adhere to the following JSON schema. Raw text streaming is strictly prohibited. Every payload must be parsed and routed by the frontend's Event Router based on the `type` property.

#### 1. Standard Output (`stream_text`)
Used for conversational text, standard CLI output, and final responses.
```json
{
  "type": "stream_text",
  "payload": {
    "content": "I have completed the repository analysis.",
    "format": "markdown" // Allows the frontend to know if it should render raw text or markdown
  },
  "timestamp": "2026-04-10T10:36:00Z"
}
```

#### 2. Processing State (`stream_thinking`)
Used to trigger the custom "Terminal Flair" UI (ASCII spinners, phosphor text, emoticons) while the agent is executing background tasks or generating tokens.
```json
{
  "type": "stream_thinking",
  "payload": {
    "status": "active", // "active" | "idle" | "error"
    "current_task": "Analyzing architecture.md...",
    "flair_theme": "retro" // Optional: allows the backend to request specific frontend themes
  },
  "timestamp": "2026-04-10T10:36:02Z"
}
```

#### 3. Secure Input Request (`prompt_secret`)
Triggers the "Vault" component. This mandates that the frontend mounts an isolated, masked `<input type="password">` field. The raw secret must be returned via a `tool_result` event and immediately wiped from the DOM.
```json
{
  "type": "prompt_secret",
  "payload": {
    "prompt_message": "Enter your database migration password:",
    "key_id": "db_pass",
    "mask_input": true
  },
  "timestamp": "2026-04-10T10:36:05Z"
}
```

#### 4. Execution Checkpoint (`tool_permission`)
Triggers the interactive "Checkpoint" component (Diff/Merge views, Approve/Reject buttons). Execution on the remote host must completely halt until the frontend returns a matching `tool_result` event.
```json
{
  "type": "tool_permission",
  "payload": {
    "action": "execute_command", // "execute_command" | "write_file" | "delete_file"
    "target": "npm install --save-dev jest",
    "risk_level": "low",
    "context": "Adding testing framework required by Phase 3 of ACTIVE_TASK.md"
  },
  "timestamp": "2026-04-10T10:36:08Z"
}
```

#### Expected Frontend Response (`tool_result`)
The standard schema the React frontend must use to reply to `prompt_secret` or `tool_permission` events.
```json
{
  "type": "tool_result",
  "payload": {
    "original_type": "tool_permission", // Ties the response to the prompt
    "status": "approved", // "approved" | "rejected" | "submitted"
    "data": null // Populated with the secure string if replying to prompt_secret
  },
  "timestamp": "2026-04-10T10:36:15Z"
}
```
