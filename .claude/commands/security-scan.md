<instructions>
Run the `/security-scan` skill. This chains AgentShield (Claude config audit) → zizmor (GitHub Actions security) → security-reviewer agent (grading).

For a quick manual run without the full pipeline:

```bash
node_modules/.bin/agentshield scan --path .claude --format terminal
zizmor .github/
```

(both are also wired into `.github/workflows/ci.yml` for CI gating.)
</instructions>
