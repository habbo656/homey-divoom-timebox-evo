---
description: Audit the local knowledge base for completeness and consistency with the code (doc-keeper agent)
---
Spawn the `doc-keeper` agent in **audit** mode on the current branch and relay its changes, remaining findings and
verdict. On `main`, it must not commit there: create `agent/docs-audit-<date>` first and ask me before merging.
