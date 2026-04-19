# Session handoff — 2026-04-19 (mid-flight, airplane stop)

> **RESOLVED 2026-04-19 (post-airplane).** The body below remains as historical
> record of where the session paused. Everything it listed as pending has
> since landed on `main` in both repos.
>
> **Summary of what shipped after the airplane stop:**
>
> - **Port from Vera → Palisade (Ports 4a–9):** ran end-to-end via the
>   continuation agent. `port/from-vera-cardchip-20260419-104759` merged
>   into Palisade's `sdm-udk-cutover` (`7cbed79` / `cc7267f`), which then
>   merged into `main` as `030e0e4`. Card-ops base service, Track-1 per-FI
>   GP keys + APDU audit log, IAD CVR/DAC/IDN (`b973e9c`), reaper script
>   (`878063c`), `@palisade/metrics` (`a52847c`), runbooks (`7967c0f`),
>   seed script for 545490 Pty Ltd + Karta USA Inc (`7065f5b`, ARN fix
>   `446ebbe`), and issuer + chip-profile admin CRUD (`e5430b3`) all
>   landed via that branch chain.
> - **Phase 4d (admin SPA dual-backend):** Vera side `255887a`; Palisade
>   side `b0dd850` (`/palisade-api` rewrite + capabilities parity), both
>   shipping in their respective `phase-5-infra` / strip merges.
> - **Phase 5 (per-repo infra + CI):** Vera Dockerfile strip `6ff0c81`;
>   Vera `aws-setup.sh` strip `5f23ec6`; Vera deploy workflow strip
>   `fa14e5a`. Palisade Dockerfile + sftp + aws-setup.sh + admin port
>   3009 `7c1a60d`; Palisade deploy workflow `a9105bb`; merged to Palisade
>   main as `ae465a0`.
> - **Agent A (install + personalise payment applet):** `70d22be` install
>   op, `027516c` personalise op, `99343dc` schema field
>   `ChipProfile.paymentAppletCapFilename`, `cf73dee` lockfile refresh,
>   all merged as `f9236e6`.
> - **Agent B (IssuerProfile bankId + progId + postProvisionUrl):**
>   backend `42e62aa` (Palisade), admin SPA form fields `4f1e80b` (Vera),
>   SPA migration-debt fix `d63aea7` (Vera), merged as `dcedae8`
>   (Palisade) + `59e4893` (Vera).
> - **Vera strip landed to main:** `31d80dc` merged
>   `worktree-separate-vera-palisade` to Vera `main`; `6cfad95` completed
>   the strip by removing card-domain files that drifted in on `main`
>   after the worktree forked; `a5e47cc` removed stranded card-domain
>   backend routes.
> - **Stashes:** all `AIRPLANE_STASH` / `OTHER_SESSION_WIP_*` entries on
>   Palisade have been absorbed into the port branch or reconciled — see
>   `git stash list` for remaining residue (one unrelated
>   `OTHER_SESSION_WIP` on `sdm-udk-cutover` and one
>   `phase3-vera-shrink-baseline` baseline stash on Vera's `main`).
> - **Phase 3 Vera schema shrink:** still deferred. Baseline captured in
>   stash entry `phase3-vera-shrink-baseline`; the shrink itself waits
>   until pay's cross-repo card-lookup call pattern is decided.
>
> Current heads: Vera `a5e47cc` (main), Palisade `dcedae8` (main).
>
> Active external gates (still pending, not blocking the repo split):
> APC key ceremony ARNs, CPI GP SCP03 master ARNs, NXP M/Chip + VSDC CAPs
> to land in `services/card-ops/cap-files/`, and mobile pickup of
> `?mode=plan` for Android NFC plan-mode testing.

Paused mid-port due to internet-loss window. Everything is committed or stashed; nothing on a loose working tree.

## State of each repo

### Vera (`/Users/danderson/Vera`, main branch)

Main HEAD: `cba7684` (admin: Issuer + Chip Profile CRUD tabs)

**Branches with in-flight work (all local, none pushed):**

| Branch | Purpose |
|---|---|
| `snapshot/track2-rca-realsad` | Track 2 RCA real SAD + metadata + attestation — 1 commit `6624497` |
| `snapshot/seed-545490-issuers` | Seed script for 545490 Pty Ltd + Karta USA Inc — 1 commit |
| `fix/iad-cvr-dacidn` | Track 5 IAD real CVR + DAC/IDN — 1 commit `8771a68` |
| `worktree-agent-aae0dd02` | Track 1 card-ops GP keys + APDU audit log — 2 commits `b8a5824` + `d6e55b7` |
| `worktree-agent-ab514253` | Track 6 reaper + metrics + runbooks — 3 commits `1849011` + `b68f58b` + `42fdf8a` |
| `feat/card-ops-service` | Original card-ops base service |
| `worktree-separate-vera-palisade` | Vera-side strip (Phase 1 strip + Phase 4b + Phase 4c Vera) — ready to merge to main |

**Scratch (gitignored, on disk only):**
- `scratch/profiles/` — parsed MC AU + Visa US profiles (contents summarized in session transcript)
- `scratch/seed-545490/seed-545490-issuers.ts` — also committed to `snapshot/seed-545490-issuers`

### Palisade (`/Users/danderson/Palisade`, port branch)

Branch: `port/from-vera-cardchip-20260419-104759`

**Commits landed:**
```
eb8a9e0 rca: Track 2 — real SAD + metadata + attestation
ac61e5c rca: clean up handleCardResponse — don't concat hex+sw, trust sw directly
5470b06 rca: add opt-in plan-mode WS protocol (?mode=plan)
eda4ae6 batch-processor: crypto.randomBytes ← sdm-udk-cutover base
73961c4 admin: Phase 4a scaffold ← sdm-udk-cutover base
...
```

**Stashes (preserve all):**
```
stash@{0}  AIRPLANE_STASH: partial Port 4a (card-ops base) ← resume HERE
stash@{1}  OTHER_SESSION_WIP_6: stash before applying port 3 schema
stash@{2}  OTHER_SESSION_WIP_5: pre-port-2-test
stash@{3}  OTHER_SESSION_WIP_4: pre-port-1-test stash
stash@{4}  OTHER_SESSION_WIP_3: more uncommitted changes — leave alone
stash@{5}  OTHER_SESSION_WIP_2: additional uncommitted changes
stash@{6}  OTHER_SESSION_WIP: sdm-udk-cutover uncommitted changes
```

`stash@{0}` AIRPLANE_STASH is MY port 4a partial — has `packages/admin-config/` new package, modified `packages/cognito-auth/` + `packages/db/prisma/schema.prisma` (adding CardOpSession migration), new `services/activation/src/routes/card-op.routes.ts` etc. Partial — missing `services/card-ops/` directory itself (not yet copied). Resume with:
```bash
cd /Users/danderson/Palisade
git stash apply stash@{0}
# then continue from Port 4a scope in the handoff agent prompt
```

## Ports still needed on Palisade (in order)

| # | Name | Source on Vera | Notes |
|---|---|---|---|
| 4a | card-ops base service | `dc95b8e`, `612c82b`, `a377217` from merge `e630c84` | partially stashed; needs `services/card-ops/` dir + completion |
| 4b | Track 1: per-FI GP keys + APDU audit log | `b8a5824`, `d6e55b7` on `worktree-agent-aae0dd02` | |
| 5 | IAD real CVR + DAC/IDN | `8771a68` on `fix/iad-cvr-dacidn` | single-file rewrite of packages/emv/iad-builder.ts + tests |
| 6 | Admin issuer + chip profile routes (backend only) | `cba7684` on Vera main | frontend deferred to Phase 4d |
| 7 | scratch/ in gitignore | trivial | |
| 8a | reaper script | `1849011` on `worktree-agent-ab514253` | |
| 8b | @palisade/metrics package | `b68f58b` — rename `@vera/metrics` → `@palisade/metrics` | |
| 8c | Runbooks (key rotation, FI onboarding, IR, attestation) | `42fdf8a` | |
| 9 | Seed script copy | `snapshot/seed-545490-issuers` / `scratch/seed-545490-issuers.ts` | copy to Palisade `scripts/` |

Full port agent brief (all 9 ports + acceptance rules) is in the conversation transcript — re-spawn the agent with the same prompt to resume.

## Merges pending (after Palisade ports land)

1. Merge `phase-4c-tier-rules-cutover` (in worktree `/Users/danderson/Palisade-4c`) + `port/from-vera-cardchip-20260419-104759` → `sdm-udk-cutover`. Expect overlap on `schema.prisma` and `programs.routes.ts` — resolve additively.
2. Merge `sdm-udk-cutover` → Palisade `main`.
3. Merge `worktree-separate-vera-palisade` → Vera `main` (destructive — deletes RCA/EMV/data-prep/tap/activation/batch-processor/sftp from Vera; requires explicit user OK).
4. Run seed script: `tsx scripts/seed-545490-issuers.ts` (on Palisade, after port and schema stable).

## Key decisions locked this session

- **Repo split**: Palisade = everything card + chip. Vera = vault + vault services only.
- **CVN 18** for M/Chip Advance v1.2.3 (swap to 17 if NXP says otherwise).
- **Dual scheme day 1** — MC AU (545490 Pty Ltd) + Visa US (Karta USA Inc).
- **Test/processor simulator** is a follow-up, not blocking.
- **CAST evaluation** deferred until post-launch per user.
- **Profile XMLs parsed** — EMV constants inventoried; summary in conversation transcript.

## External gates (not my work)

1. APC key ceremony ARNs → populate 5 ARNs per IssuerProfile (admin UI or SQL)
2. CPI GP SCP03 master ARNs → populate 3 ARNs per IssuerProfile
3. NXP M/Chip + VSDC applets arriving this week → DGI definitions + T7 `install_payment_applet` op
4. Mobile app picks up `?mode=plan` flag → Android NFC test
5. Flip `DATA_PREP_MOCK_EMV=false` once (1) is done

## Phases still to schedule

- **Phase 4d** — frontend SPA capability-gated per backend (Vera: vault/tx/audit/tokenisation; Palisade: cards/programs/provisioning/etc.)
- **Phase 5** — Palisade Dockerfile + aws-setup.sh; per-repo CI; secret namespace split
- **Phase 3 Vera schema shrink** — deferred until pay's cross-repo call pattern (pay→Palisade card lookup) is decided

## Resume command at hotel

1. Read this file first.
2. Re-spawn the continuation port agent with the same prompt (in transcript) OR cherry-pick individual ports by hand.
3. First step: `cd /Users/danderson/Palisade && git stash apply stash@{0}` to resume Port 4a from where we left off.

See also: `/Users/danderson/.claude/projects/-Users-danderson-Vera/memory/project_split_in_progress.md` for the authoritative split plan (updated 2026-04-19).
