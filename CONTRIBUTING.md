# Contributing to SWF

Thank you for helping improve SWF. The project welcomes focused bug fixes,
documentation improvements, tests, and well-scoped feature proposals.

## Before opening a change

- Search existing issues and pull requests to avoid duplicate work.
- Open a feature request before implementing a substantial behavior or public
  API change.
- Report security vulnerabilities privately according to
  [SECURITY.md](SECURITY.md), not in a public issue.
- Keep each pull request focused on one coherent change.

Behavioral changes should update the relevant OpenSpec artifacts as well as the
implementation. Small documentation and test corrections do not need a new
OpenSpec proposal unless they change promised behavior.

## Development setup

SWF requires Node.js 24, pnpm 11.20.0, and the other tools listed in the
[README](README.md#requirements).

```sh
git clone https://github.com/chriskealley/swf.git
cd swf
corepack enable
corepack prepare pnpm@11.20.0 --activate
pnpm install
```

Use an isolated checkout-local development instance:

```sh
pnpm dev start --instance local
pnpm dev status --instance local
pnpm dev stop --instance local
pnpm dev clean --instance local --yes
```

Do not point tests or fixtures at a personal repository. The default fixture
and test paths are local-only and do not invoke paid harnesses or mutate remote
repositories. See [Contributor development](docs/development.md) for the full
development workflow.

## Verification

Run the checks appropriate to your change. Before requesting review, the full
local baseline is:

```sh
pnpm check
pnpm test
pnpm test:e2e
pnpm verify:product
pnpm verify:release --channel=development
pnpm verify:release-guard
pnpm exec openspec validate --specs --strict
```

Add or update tests for behavior changes. Do not weaken a test merely to make a
change pass, and do not commit generated output from `dist/` or private runtime
state.

## Pull requests

- Use a clear title and explain the problem and resulting behavior.
- Link the relevant issue or OpenSpec change when one exists.
- Call out compatibility, migration, security, or release implications.
- Include screenshots for dashboard changes where they improve reviewability.
- Keep commits reviewable; maintainers may squash them when merging.
- Confirm that CI passes and respond to review feedback.

By contributing, you agree that your contribution is licensed under the
project's [MIT License](LICENSE) and that you will follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
