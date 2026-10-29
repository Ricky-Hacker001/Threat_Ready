# audit/ — internal audit material

Everything under this folder is **internal**: security audit reports with file:line evidence and exploit
payloads, patch notes with "still open" lists, UI/UX audit PDFs and screenshot evidence. It is tracked in
this repository so the history of findings and fixes stays with the code, but it is never part of anything
that leaves the repository:

- `scripts/publish.rsync-filter` drops `/audit/` when the tree is copied to a publish checkout, and
  `node scripts/publish-check.mjs --published <dir>` (also every folder/zip check) fails if `audit/` is
  present in the result.
- The marketing site (`Landing_Page-main/`, GitHub Pages) no longer contains `docs/`: `audit/Landing_Page-main/docs/`
  holds what used to render at `https://threatready.io/docs/AUDIT.html`. `Landing_Page-main/_config.yml`
  additionally excludes `tools/`, `docs/`, `README.md` and `*.py` from the Pages build.
- Nothing under `audit/` is served by the gateway or any app; no app imports from it.

Layout (paths below `audit/` mirror where the material lived before 29 Oct 2026, so links in the reports
keep their shape):

| Path | Content |
| --- | --- |
| `docs/AUDIT_REPORT_2026-10-15.md` | 15 Oct security audit (ReDoS payloads, secret handling, grants) |
| `docs/SECURITY_PATCH_2026-10-23.md`, `docs/SECURITY_PATCH_2026-10-24.md` | Patch 1 notes |
| `docs/SECURITY_PATCH_2_2026-10-23.md`, `docs/MERGE_PATCH_2_2026-10-26.md` | Patch 2 notes and merge record |
| `docs/*.pdf`, `docs/audit-evidence/` | UI/UX audit PDFs and screenshots (the Markdown reports stay in `/docs`) |
| `reports/` | 28 Oct UI/UX/SEO audit and its before/after evidence |
| `Landing_Page-main/docs/` | Marketing-site audit and redesign report (moved out of the Pages root) |

If the repository itself is public, this folder is public too (see decision D5 in the 29 Oct audit: make
the repository private until launch, or move this folder to the wiki / an internal drive).
