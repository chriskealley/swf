# Contributor development

SWF development instances are named, checkout-local, and isolated from an
installed SWF service. Each instance owns a distinct loopback endpoint,
dashboard endpoint, credential, registry, service home, process identity, and
logs below `.swf-dev/<instance>/`.

Do not globally link the checkout or define a shell function. Install the
workspace dependencies once, then use the repository command:

```sh
corepack enable
corepack prepare pnpm@11.20.0 --activate
pnpm install
pnpm dev start --instance local
```

The start summary prints the exact environment needed by the checkout CLI. For
example:

```sh
SWF_SERVICE_HOME="$PWD/.swf-dev/local/service-home" \
NODE_OPTIONS=--enable-source-maps \
pnpm swf status <change-name>
```

Use `swf init --cwd /path/to/project --trust` for another worktree, then use
the displayed project or run selectors when cwd would otherwise be ambiguous.
The checkout supplies the code; the explicit selectors supply the target.

## Fast source mode

`pnpm dev start` starts one supervisor for both development servers:

- Nitro watches service and shared core/integration source;
- Vite serves the dashboard with HMR on its own strict loopback port;
- `NODE_OPTIONS=--enable-source-maps` applies to the service and checkout CLI;
- `VITE_SWF_ENDPOINT` points the dashboard at this instance's service; and
- both processes inherit only this instance's SWF home and endpoint.

Most stateless changes use the development servers' normal reload behavior.
Changes to scheduler, event-store, harness-lifecycle, service-runtime, or
server-plugin ownership code are different: the supervisor stops the old
watcher, confirms the isolated writer PID has exited, clears only stale owned
lock metadata, and then starts the replacement. It refuses to start a second
scheduler if ownership cannot be released.

The dashboard still requires the private bearer credential recorded in the
instance service metadata. Credentials are not printed into shared logs or
persisted by the dashboard.

## Instance lifecycle

```sh
pnpm dev list
pnpm dev status --instance local
pnpm dev logs --instance local --lines 100
pnpm dev restart --instance local
pnpm dev stop --instance local
pnpm dev clean --instance local --yes
```

`stop` signals the recorded supervisor, which stops both child watchers.
`clean` requires explicit confirmation and removes only the selected instance.
It never reads or modifies `~/.config/swf`, port `34671`, another development
instance, or project state outside that instance.

## Production-like preview

Fast mode optimizes iteration; preview validates distribution behavior:

```sh
pnpm dev preview --instance release-preview
pnpm dev status --instance release-preview
pnpm dev logs --instance release-preview
pnpm dev stop --instance release-preview
pnpm dev clean --instance release-preview --yes
```

Preview builds the product, verifies its allowlisted contents, copies it into
the isolated instance, installs declared production dependencies, and launches
the compiled service entry. It rejects TypeScript runtime entries, `tsx`, pnpm
workspace filters, Nitro development mode, Vite development mode, and runtime
resolution back into the checkout.

Preview is production-like but non-publishable: its build metadata records the
source commit and dirty state and labels the channel `development`.

## Disposable fixtures

Create a temporary committed Git repository with OpenSpec configuration and
local-branch delivery:

```sh
pnpm dev fixture
pnpm dev fixture --retain --change example-change
```

The default fixture is removed after creation unless `--retain` is supplied.
Live harness execution and hosted delivery remain disabled unless separately
enabled with `--live-harness` or `--hosted-delivery`; normal fixture and test
runs never spend paid harness capacity or mutate a remote repository.

## Verification commands

```sh
pnpm check
pnpm test
pnpm test:e2e
pnpm verify:product
pnpm verify:release --channel=development
pnpm verify:release-guard
```

Release verification assembles, packs, installs, and smokes the exact product
and Pi-extension tarballs, then writes non-publishable development evidence to
`dist/release/`. A stable verification additionally requires a clean identified
commit and a stable SemVer version.

Service output for an installed or packaged instance is available through
`swf service logs`; development output is available through `pnpm dev logs`.
Managed launchd/systemd behavior is documented in
[Operations](./operations.md#managed-user-service).
