# Hermes Gateway: isolated validation plan

Scope: PR #1, test/2026.1023.0-pr14526, base v2026.1023.0.

1. Diagnose CI logs and distinguish implementation errors from workflow drift.
2. Use the branch-owned reusable workflow and Ubuntu 24.04. Keep all test gates.
3. Build the production Docker target with source commit metadata, no secret arguments, and a credential-free context.
4. Boot on a GitHub-hosted runner with network disabled and tmpfs data. Verify health, empty companies, UI and restart.
5. Publish only the tested image to the separate test package. Record its registry digest and source SHA.
6. Keep PR draft until checks and isolated validation pass. No production operations, master merge, VPS access, or paperclip_data access.

Acceptance: relevant Hermes regression tests, full CI and Docker smoke pass; a registry digest identifies the tested candidate; backup/restore/rollback procedure is reviewed. Any unexecuted check remains explicitly pending.
