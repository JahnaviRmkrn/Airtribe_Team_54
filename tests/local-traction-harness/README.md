# Credential-free Traction server-component + PostgreSQL fixture

This test-only fixture runs the **actual checked-in `TractionPage` →
`readTractionData` → complete-read helper → ledger**, backed by real in-memory
PGlite service-role SQL. It renders that server component using React static SSR
inside a visibly labelled fixture HTML shell. No successful page, API response
or ledger result is fabricated. The unchanged `app/globals.css` and
`app/traction/traction.css` are served byte-for-byte.

This is **not** a full Next server/runtime, hydration, Next layout/navigation,
production cache, PostgREST, Supabase Auth or deployed-provider test. The
`next/cache` wrapper calls the real loader directly, without caching. Admin
client construction is replaced with the limited PGlite adapter; relevant
admin user lookups return fixed synthetic email/unknown/error results. These
are service-role reads, **not owner RLS or a browser account simulation**.
There is no sign-in, OAuth or live identity lookup. The existing ledger's
same-timestamp seeded heuristic is exercised, not validated as a reliable
classification of real-world people.

## Launch and lifecycle

Use the installed dependencies, no package install or hooks. Do not run Next,
load `.env`, credentials, Vault, real auth sessions or provider connections.
From an isolated checkout:

```sh
./tests/local-traction-harness/run.sh smoke
# Only the coordinated native browser operator, on the browser machine:
./tests/local-traction-harness/run.sh serve
```

The launcher uses `env -i`, test mode, UTC and fixed synthetic Traction settings:
cutoff lower bound `2026-10-24T00:00:00Z`, test domain `example.com`, team first
name `FixtureTeam`. No arbitrary settings are copied from the caller. Vite's
env directory is a new empty temporary directory, removed on exit. Native
config loading and no cache prevent writes through the dependency symlink.
One worker is used.

`smoke` binds an ephemeral **127.0.0.1** port, runs all scenarios and closes.
`serve` runs that smoke first, resets to **complete**, and prints
`LOCAL_TRACTION_HARNESS_READY`. It binds **127.0.0.1:4324 only**, with no port or
interface fallback. If occupied, stop the known fixture rather than killing an
unknown process. Then open:

- Controls: `http://127.0.0.1:4324/__harness/`
- Actual server-component output: `http://127.0.0.1:4324/traction`

The listener stops after 30 minutes, Ctrl-C/SIGTERM or the fixed Stop button.
Listener, sockets and in-memory database are cleaned up; no persistence is
written. Reset replaces all fixture rows, clears faults/query evidence and
requires reloading the Traction tab. Requests and resets are serialized.

## Fixed scenarios and expected output

| Control | SQL baseline | Actual page expectation |
|---|---|---|
| Five complete genuine visits | 5 attendees, 5 votes, 5 referenced rooms | 5 joined, 5 shared, 5 completed, 5 rooms; no unverified warning |
| Mixed exclusions | 10 attendees, 10 votes, 9 referenced rooms | Same 5 counted visits/rooms; 1 test, 2 seeded, 1 team, 1 unverified exclusion |
| Genuinely empty | 0 attendees, votes and rooms | Successful zero totals and “No guest activity yet today” |
| Nonempty, zero-row transport cap | Same 5/5/5 as complete | Load error, **not** zero totals or an empty-activity success |
| Organizer lookup error | Same 5/5/5 as complete; one fixed identity lookup fails | 5 visibly unverified visits, 0 counted; **not** a collection-load error |

All ordinary scenarios cap each attendee, vote and referenced-room SELECT at
**two rows**, even if a caller omits `.limit()`. SQL applies that fixed cap.
Exact HEAD counts remain uncapped and use the production filters/cursors. The
complete baseline takes `[2, 2, 1, 0]` data rows then HEAD count zero in **each**
stream; the fifth guest/room is therefore beyond the first backend page.

Cap zero still executes a real one-row SELECT and truncates its returned data
to zero at the fixture transport boundary (the test SQL adapter disallows
`limit(0)`). The actual reader then issues real exact HEAD SQL, sees positive
remaining rows and fails. This models a zero-row transport cap, not an empty
database or a successful fake page response.

All counted visits use unique joined instants. Mixed adds a test-domain
organizer, a two-row equal-timestamp seed pair, a fixed team first name and an
unknown synthetic organizer. The final counted guest is **Guest 5 in room 5**:
join `2026-10-24T01:05:00Z`, vote `2026-10-24T01:05:30Z`, shown as **24 Oct,
6:35 am IST** by the actual page formatter. The complete/mixed activity list has
ten anonymous join/vote entries. Private synthetic names, organizer emails,
UUIDs, secret hashes and room tokens must never appear in page HTML.

## Fixed one-shot failures and evidence

`POST /__harness/reset` accepts exactly
`{"confirm":"reset-traction-fixture","scenario":"complete"}`, or one of the
other four fixed scenario names: `mixed`, `empty`, `zero-cap`, `lookup-error`.

`POST /__harness/read-failure` accepts exactly
`{"confirm":"fail-next-traction-page2","target":"attendees"}`, or target
`votes`/`meetups`. It requires complete/mixed and no pending fault. The selected
stream's first page executes real SQL and returns two rows. On its next cursor
page, the adapter returns one database-style error. This is an explicit
synthetic transport/adapter fault, not an injected PostgreSQL engine failure. The real reader fails and
the real page renders its load-error branch; it is not a whole-page fault mock.
Other assets/status reads do not consume it. The next page reload succeeds
without rearming. Reset clears pending and consumed evidence.

**The SSR response can remain HTTP 200 when data loading fails**, matching the
current server component's catch branch. Acceptance means the visible error
message and absence of the success headline/funnel—not a claimed HTTP 503.
Identity-lookup errors instead return complete collection data with unknown
identity and retain the separate unverified disclosure.

Controls reject unknown fields/scenarios/targets, query inputs, arbitrary
count/SQL/URL/body overrides and missing confirmations. Status contains only
synthetic aggregate counts, expected baseline, cap, bounded per-query
(table/head/cursor/row-count/error) evidence, lookup-call count, failure
consumption and source SHA-256 hashes. It never returns data rows or identities.
Hashes cover the actual page, reader, ledger, shared helper and both CSS files;
smoke checks hashes before rendering and CSS byte equality. Baseline expectations
are fixed, not live-production counts.

## Native browser checklist (not implied by smoke)

Use only this synthetic local fixture. Do not enter personal data or credentials,
open external services or send/share messages. No actual browser has been used
merely because the HTTP smoke passes.

1. Start serve in the browser machine's native terminal and wait for readiness.
   In controls choose **Five complete genuine visits (cap 2)**, then open
   `/traction`. Verify the actual heading says **5 people planned a meetup with
   muop**, all four funnel totals are **5**, and no unverified warning appears.
   Locate **Guest 5 in room 5** and its **24 Oct, 6:35 am** join/vote entries;
   labels are anonymous, not the private seed names. The page's counting note
   explicitly labels IST. There should be ten activity entries.
2. Refresh controls status: each stream's last query sequence must show data
   rows **2, 2, 1, 0**, then **HEAD count 0**, with only one relevant synthetic
   identity lookup. Check the displayed source hashes against the tested
   checkout. This evidence distinguishes complete pagination from uncapped SQL.
3. Select **Mixed exclusions**, reload Traction. Verify all four totals stay 5;
   **1 unverified visit** is prominently disclosed **above the success heading**.
   “How we count” reports **1 test, 2 seeded demo, 1 team**. Verify no private
   guest/room names, organizer emails, UUIDs, tokens or secret values appear.
4. Return to complete. Arm **Fail next attendee page 2**, reload Traction and
   observe the unavailable-numbers message. There must be **no success headline
   or funnel and no successful empty-activity message**. HTTP may be 200. Status
   must show target attendees, consumed once, page 2, first-page rows 2. Reload
   without rearming: all totals return to 5. Repeat for **votes** and **meetups**.
5. Select **Nonempty, zero-row transport cap**, reload: the page must show the
   load error, not zero totals. Status still reports five SQL rows in each
   baseline table, zero-row SELECT output and a positive exact HEAD count.
6. Select **Genuinely empty**, reload: zero totals plus genuine no-activity text,
   no error and no unverified warning. Status shows zero SQL rows and verified
   zero HEAD counts. This is distinct from step 5.
7. Select **Organizer lookup error**, reload: verify **5 unverified visits**
   above the zero-count success headline, not an unavailable-numbers error.
   The collections loaded completely; only the fixed identity boundary failed.
8. Inspect the page at **320 CSS pixels wide** and a normal desktop width.
   Verify heading, two-column mobile funnel, exclusion note and activity rows
   are readable without clipped essential text. The CSS is unchanged; fonts
   fall back to system fonts because Next font/layout loading is not reproduced.
   Keyboard/readability checks are native observations, not proof from SSR text.
9. Restore complete; verify faults cleared. Stop through controls or Ctrl-C.
   Record source hashes, browser, viewport and actual observations separately
   from smoke. Do not claim Next caching/hydration or a live deployment test.

## Safety and automated proof

Exact path/method allowlists, exact loopback Host, loopback client and same-origin
mutation/Fetch Metadata checks remain enforced. No directory browsing or generic
proxy exists. Self-only CSP blocks external scripts/styles/fonts/connections;
frames, workers, media, camera, microphone, location and payments are disabled.
Responses are no-store/no-referrer with MIME sniffing and DNS prefetch disabled.
Requests have 5-second upload/header limits, 1 KiB control bodies, 8 KiB headers
and at most 16 connections. This is trusted-code isolation, not an OS network
sandbox.

Application fetch is installed as a throwing guard before imports. HTTP helpers
permit only the exact fixture origin, HTTPS throws, and live Supabase/Auth,
payment, voice and secret modules are deny-only. SQL helper loading excludes
Vault without opening it; the remaining migrations run only against this
in-memory local database, never a service. File reads reject env/Vault paths, and guarded probes
are reset before zero-counter assertions. No provider or credential accessor is
called. App exception objects are suppressed/count-only, not logged.

Smoke covers CSS equality/hashes, host/origin/path/control denials, direct real
SQL baselines, all three capped page traces, all fixed count/exclusion scenarios,
private-value absence from page/status, one-shot second-page failures/recovery,
cap-zero versus genuine empty, reset cleanup, zero unexpected external/provider/
secret accesses and shutdown. Actual page/read/ledger code executes, but Next
cache, full runtime, native layout and live infrastructure remain outside this
fixture's evidence.
