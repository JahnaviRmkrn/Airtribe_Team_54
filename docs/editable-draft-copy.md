# Editable draft copy feedback

A copy operation captures the text at activation. An already-started native
clipboard write cannot be cancelled or changed. Editing does **not** initiate a
second write or claim to undo that old write; the user must activate Copy again
after it settles to copy the edited text.

The draft editor tracks an input revision. Any edit, including edit then revert:

- clears previous Copied feedback, its timer, and any manual-copy fallback;
- preserves the original pending-write lock and busy/disabled state;
- makes that pending completion ineligible to show success, stale fallback text,
  or steal focus from the editor;
- leaves controls usable when the pending operation settles.

Unchanged draft and fixed room-link copying retain their existing behavior.
Navigation, detached controls and newer attempts still suppress stale feedback.
This is a presentation fix, not a guarantee about operating-system clipboard
contents after an outstanding write.

`tests/manual-copy-ui.test.mjs` executes the shipped draft editor/copy functions
with synthetic DOM, API and clipboard substitutes. It covers success/rejection,
edit/revert, duplicate pending activation, navigation, feedback cleanup and an
explicit later copy of the new content. It never invokes native clipboard,
permissions, providers or an external messaging application.

Native acceptance must use the separately reviewed fixture's immutable in-memory
clipboard substitute, discrete typing keys (not paste/clipboard tools), and
neutralized external handoffs. Verify pending success and denial after edits,
no stale Copied/fallback/focus, then a deliberate later copy of the edited text.
Do not infer real clipboard writes or external sending from that fixture.
