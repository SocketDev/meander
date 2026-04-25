---
name: security-scan
description: Runs AgentShield on .claude/ config and zizmor on GitHub Actions, then has the security-reviewer agent grade A-F. Use after touching .claude/, hooks, agents, or workflows, and before releases.
user-invocable: true
---

# Security Scan

Multi-tool security scanning pipeline for the meander walkthrough
generator. Orchestrates AgentShield + zizmor (already wired into
`.github/workflows/ci.yml`) and a graded review.

## When to Use

- After modifying `.claude/` config, settings, hooks, or agent definitions
- After modifying GitHub Actions workflows under `.github/`
- Before releases (called as a gate by the release pipeline)
- Periodic security hygiene checks

## Prerequisites

See `_shared/security-tools.md` for tool detection paths.

## Process

### Phase 1: Environment Check

Follow `_shared/env-check.md`. Initialize a queue run entry for `security-scan`.

---

### Phase 2: AgentShield Scan

Scan Claude Code configuration for security issues:

```bash
node_modules/.bin/agentshield scan --path .claude --format terminal
```

Checks `.claude/` for:

- Hardcoded secrets in CLAUDE.md and settings.json
- Overly permissive tool allow lists (e.g. `Bash(*)`)
- Prompt injection patterns in agent / skill definitions
- Command injection risks in hooks
- Risky MCP server configurations

Capture the grade and findings count.

Update queue: `current_phase: agentshield` → `completed_phases: [env-check, agentshield]`

---

### Phase 3: Zizmor Scan

Scan GitHub Actions workflows for security issues.

See `_shared/security-tools.md` for zizmor detection. If not
installed locally, skip with a warning — CI always has it via the
`.github/actions/setup-and-install` composite.

```bash
zizmor .github/
```

Checks for:

- Unpinned actions (must use full SHA, not tags)
- Secrets used outside `env:` blocks
- Injection risks from untrusted inputs (template injection)
- Overly permissive permissions

Capture findings. Update queue phase.

Note: meander's `.github/zizmor.yml` config disables the
`secrets-outside-env` rule (intentional — see the comment in that
file). Don't re-flag findings the upstream config has silenced.

---

### Phase 4: Grade + Report

Spawn the `security-reviewer` agent (see `agents/security-reviewer.md`)
with the combined output from AgentShield and zizmor.

The agent:

1. Applies CLAUDE.md security rules to evaluate the findings
2. Calculates an A-F grade per `_shared/report-format.md`
3. Generates a prioritized report (CRITICAL first)
4. Suggests fixes for HIGH and CRITICAL findings

Output a HANDOFF block per `_shared/report-format.md` for pipeline
chaining.

Update queue: `status: done`, write `findings_count` and final
grade.

---

## Reference

For rule catalogs (AgentShield + zizmor), common false positives,
severity decision tree, and fix recipes — load
[reference.md](./reference.md) when triaging findings.
