# Cloud Conflict Tests

Current browser coverage:

- [x] Resolve a remote conflict in Monaco diff mode with `Save resolved version`

Next cases to cover:

- [x] Accept cloud version for a remote conflict
- [x] Save my current draft separately for a remote conflict
- [x] Remote deletion conflict (`diskFile === null`)
- [ ] Leave diff mode, switch notes, return to the unresolved conflict, then resolve it
- [ ] Multiple simultaneous conflicts in one sync
- [ ] Open and resolve from the tree conflict popover, not only the status bar

Additional edge cases:

- [ ] Continue typing with an unresolved conflict in plain editor; autosave stays suppressed and the draft remains intact
- [x] `Save my current draft separately` creates exactly one conflict copy and leaves the expected note open
- [x] Cloud deletion uses the correct deletion-specific labels and outcomes
- [ ] Resolving a conflict clears stale conflict UI and leaves the normal editor active
- [ ] Narrow viewport diff layout remains usable
- [ ] Focus/visibility/online auto-sync triggers stay non-disruptive while a conflict is unresolved
