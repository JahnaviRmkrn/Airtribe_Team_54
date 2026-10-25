# Contact editor keyboard acceptance

The contact detail editor uses a native form. Opening it moves focus to Name;
Save submits the form (including Enter from an eligible single-line field), and
Cancel is explicitly not a submit button. Browser constraints apply to required
Name, email and minimum frequency. API errors remain in the draft as a focusable
alert; a status announces the pending save. While saving, duplicate submission
and Cancel are ignored and form controls are disabled. Save/Cancel reload the
detail and focus its new Edit details button only if the view still owns navigation.
The check-in form remains intentionally paused while editing contact details.

`tests/contact-edit-keyboard.test.mjs` executes the shipped editor function with
synthetic DOM/API objects and deferred requests. It proves semantic markup,
explicit focus calls, pending guards, error/draft recovery and stale callbacks.
It does **not** emulate a browser's Enter/default-submit behavior, accessibility
tree, screen reader or focus scrolling. Existing date tests now submit the actual
form handler and continue to check precise stored follow-up instants.

For native acceptance, use only the credential-free organizer fixture and
synthetic records (see `tests/local-organizer-harness/README.md`):

1. Open a contact detail, activate Edit details with the keyboard, and confirm
   the focused Name field is visible even when a long history precedes the
   bottom Edit details button.
2. Change a synthetic note and press Enter. Confirm one save and reloaded detail,
   focus on Edit details, and persisted note. Do not activate email/share links.
3. Reopen, edit and activate Cancel. Confirm no saved draft and return focus.
4. Try a blank required name, invalid email or zero frequency; browser validation
   should prevent submission. Separately use a whitespace-only name to exercise
   the real API validation error: the error is visible/focused, the draft remains,
   and correcting it permits saving.
5. Inspect role=alert/status and form/button semantics. Only claim screen-reader
   output if it was actually tested with an assistive technology; DOM inspection
   alone is not that evidence. Deferred race checks remain unit-test evidence
   unless separately exercised with a controlled transport.
