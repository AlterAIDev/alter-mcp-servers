# Contributing

Pull requests are welcome.

- Run `pnpm typecheck`, `pnpm test` and `pnpm build` before opening one.
- `src/alter.ts` is shared: every package carries an identical copy so each publishes on its own. Change all copies together; `pnpm test` fails if they differ.
- New tools must call the provider through Alter (`AlterCaller.proxy`), never with a token of their own, and must use the provider's official API.
- Add a test for every tool change. Tests use a fake Alter client, so they need no account.
- Keep tool descriptions honest about what is held for approval and what the tool cannot do.
