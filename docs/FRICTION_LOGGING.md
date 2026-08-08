# Friction Logging

This workspace supports optional [Frog](https://github.com/wevm/frog) friction logging. Frog records reproducible papercuts in `.agents/friction-log/`, so unresolved tooling or workflow problems become visible instead of being repeatedly rediscovered.

## Enable when useful

```bash
npx frog init
# or install first: npm install -g frog
frog init
```

Agents should run `frog list` before logging, then use `frog log` when they hit a repeatable development friction. Do not log secrets, personal information, one-off mistakes, or global/system issues. Commit the friction entry with the change that exposed it.

During the sprint, do not block feature delivery on publishing or reconciling issues. Review unresolved entries at checkpoints and after the sprint. Choose only one Frog automation mode (App or Action-only) to avoid duplicate reports; ask before changing repository permissions or adding a GitHub workflow.
