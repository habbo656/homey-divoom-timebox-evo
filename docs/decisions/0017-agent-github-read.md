# ADR 0017: Agents read issues and PRs live through a read-only script

**Status:** accepted · **Date:** 2026-11-07 · **Amends:** 0011 (model jobs had no GitHub access)

**Context:** The agent context held only the comments of the issue, while hardware test and review reports and the
owner's feedback are on the PR. On #4 the findings said "report on PR #38", and the developer blocked three times because
it could not read it; the owner's PR comment reached no agent. `/agent retry` with instructions did not replan, and
`/agent answer` on a PR started a run that did not see the answer. The owner asked for agents with GitHub access.

**Decision:**
- The refine, develop and review sessions get the job's read-only `GITHUB_TOKEN` as `GH_READ_TOKEN` and read issues and
  PRs live with `scripts/agent/gh-read.sh issue|pr N`: comments, reviews and inline review comments.
- Not plain `gh`: `gh auth token` prints the token and `gh api --hostname` sends data to any host, and deny rules match
  command prefixes only. The script takes a command and a number, no host or path. `Bash(gh *)` stays denied.
- The script returns only what the owner and the bot wrote, so the ADR 0011 rule that only their comments reach a model
  holds on this path too.
- The research and hardware test sessions on the Mac and the tool-less screen get no token: an injection there would
  have the bench as well.
- `plan-state` reads the comments of the issue and its agent PRs in order of time. `/agent answer`, and `/agent retry`
  with text, replan on either. A plain owner comment starts nothing; the next run reads it.

**Consequences:** Fix rounds work from the real report, and owner comments on the PR reach the agents. The token is in
the session's environment, so a session that writes its own HTTP code gets past the script's filter and can read
other users' public text; it still cannot write, and the token ends with the job. The injection screen does not see PR
comments; only the owner's and the bot's are returned. The prompts and the script come from the checked-out branch, so a
branch from before this change needs `main` merged in first (the bot cannot, it has no Workflows permission).
