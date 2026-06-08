# dhee-skills (Claude Code plugin)

Installable authoring skills for **dhee-core**:

- **`bundle-authoring`** — create a new pipeline (bundle) by wiring
  existing runners (data only, no TypeScript).
- **`runner-authoring`** — write a new runner (the TypeScript module that
  executes a node).

## Install

```
/plugin marketplace add dheeai/dhee-core
/plugin install dhee-skills@dhee
```

After install the skills are namespaced: `/dhee-skills:bundle-authoring`,
`/dhee-skills:runner-authoring`.

> If you're working **inside a clone of dhee-core**, you don't need to
> install anything — the same skills are auto-discovered from
> `.claude/skills/` with no namespace prefix.

## Note on layout

The canonical skill files live at the repo's `.claude/skills/<name>/`.
The `skills/` entries here are **symlinks** to those, so the plugin ships
the exact same content with no duplication. (On Windows, ensure
`git config core.symlinks true` before cloning, or the links materialize
as plain files.)

---

This is distinct from the **`dhee-runner-*` / `dhee-bundle-*` npm
package** convention — that's how the *runners and bundles themselves*
are distributed for dhee-core to load at runtime. See
`docs/ecosystem-package-conventions.md`. This plugin only distributes the
authoring *guides*.
