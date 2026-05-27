# Bug Log

Append-only ledger of observed bugs during the bundle migration and
beyond. Each entry follows the structure below. Before logging a new
bug, `grep docs/bugs.md` for similar entries AND `git log --grep` for
prior fix attempts — update the existing entry instead of duplicating.

Status values: `open` | `investigating` | `fixed` | `wont-fix`

Each `fixed` entry must point at the regression test (file path + test
name) that exercises the fix. Test pass = bug closed.

---

## Format template

```
### BUG-NNN — <one-line symptom>
- **Status:** open | investigating | fixed | wont-fix
- **Discovered:** YYYY-MM-DD
- **Reporter:** <user | claude | test>
- **Symptom:** what was observed externally
- **Evidence:** log lines, stack traces, repro commands (verbatim)
- **Suspected root cause:** best current hypothesis (mark as suspected, not confirmed)
- **Manifestations to test:** brainstorm all surfaces, not just the observed one
- **Test:** path to regression test (if fixed)
- **Fix commit:** SHA (if fixed)
```

---

(No bugs logged yet for the bundle migration. The hybrid-era bugs that
prompted the migration are documented in the commit history of the
`feat/dag-bundles` branch, not here.)
