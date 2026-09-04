# Security policy

## Supported versions

SWF is pre-1.0. Security fixes are provided for the latest published release.
Older releases and development snapshots are not supported. Before the first
release, reports against `main` are welcome.

| Version                  | Supported |
| ------------------------ | --------- |
| Latest published release | Yes       |
| Older releases           | No        |

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue, discussion, pull
request, or workflow log.

Use GitHub's private vulnerability reporting from the repository's **Security**
tab and select **Report a vulnerability**. Include:

- the affected version or commit;
- impact and realistic attack conditions;
- reproduction steps or a minimal proof of concept;
- any suggested mitigation; and
- whether the report or its details may be credited publicly.

Please omit real credentials and sensitive third-party data. Use placeholders
or purpose-created test accounts in reproductions.

The maintainer will acknowledge the report, assess its severity, coordinate a
fix and release where necessary, and agree on disclosure timing with the
reporter. Response times may vary for this independently maintained project.

## Security scope

Reports about authentication boundaries, credential or log disclosure,
repository mutation, command execution, path traversal, workflow approval
bypass, artifact integrity, and dependency or supply-chain compromise are in
scope. General support requests, feature requests, and reports without a
security impact belong in the public issue tracker.
