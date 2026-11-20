# Profile contract

Minimal copy of the `pickagent.profile/v1` schema (parse, encode, hash, and
building the profile from usage reports).

Source: private `pickagent` repository, commit
[`ce76224d0864316df4f83bb302426b4e0035083e`](https://github.com/ivrusson/pickagent/commit/ce76224d0864316df4f83bb302426b4e0035083e).

| Here | There |
| --- | --- |
| `src/profile/ids.ts` | `src/lib/engine/ids.ts` |
| `src/profile/profile.ts` | `src/lib/engine/profile.ts` |
| `src/profile/ccusage.ts` | `src/lib/engine/ccusage.ts` |
| `src/profile/fragment.ts` | `src/lib/engine/fragment.ts` |
| `src/profile/merge-sources.ts` | `src/lib/engine/merge-sources.ts` |
| `src/profile/fixtures/orchestrator.ts` | the `orchestrator` fixture in `src/lib/engine/fixtures/profiles.ts` |

`index.ts` only re-exports those modules for the CLI.

Cuts relative to the original: comments that pointed at other parts of the
product. The schema, `parseProfile`, `encodeProfile`, `profileToHash`, and the
step from usage reports to a profile are unchanged. The test fixture is only
`orchestrator` (and `hoursOf`, which that fixture needs). The other personas
in `fixtures/profiles.ts` are not here.

## How to resync

1. Pick the pickagent commit you want to follow.
2. Copy the five files in the table over `src/profile/`.
3. Replace `fixtures/orchestrator.ts` with that fixture and the hours helper
   it uses. Do not copy the other test personas.
4. Do not copy any other file from the source directory. If one of the five
   starts importing a module that is not in this table, delete that import
   and any code that exists only to serve it.
5. Strip comments that name pieces that do not live in this repository.
6. Write the new source commit in this file.
7. `npm test` and `npm run build`. Check `dist/cli.js`: it must still be only
   the scanner and this contract.
