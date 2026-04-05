# Cloud Conflict Tests

Current browser coverage:

- [x] Resolve a remote conflict in Monaco diff mode with `Save resolved version`

Next cases to cover:

- [x] Accept cloud version for a remote conflict
- [x] Save my current draft separately for a remote conflict
- [x] Remote deletion conflict (`diskFile === null`)
- [x] Leave diff mode, switch notes, return to the unresolved conflict, then resolve it
- [x] Multiple simultaneous conflicts in one sync
- [x] Open and resolve from the tree conflict popover, not only the status bar

Additional edge cases:

- [x] Continue typing with an unresolved conflict in plain editor; autosave stays suppressed and the draft remains intact
- [x] `Save my current draft separately` creates exactly one conflict copy and leaves the expected note open
- [x] Cloud deletion uses the correct deletion-specific labels and outcomes
- [x] Resolving a conflict clears stale conflict UI and leaves the normal editor active
- [x] Narrow viewport diff layout remains usable
- [x] Focus/visibility/online auto-sync triggers stay non-disruptive while a conflict is unresolved
