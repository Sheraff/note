# Test Coverage Audit

Current test stack:
- Node-only Vitest tests in `test/files.test.ts`, `test/notes.test.ts`, `test/storage.test.ts`, `test/sync.test.ts`
- `@solidjs/testing-library` tests in `test/statusbar.solid.test.tsx`, `test/notes-sidebar.solid.test.tsx`, and `test/solid-testing-library-demo.solid.test.tsx`
- Playwright browser tests in `test/playwright-demo.browser.test.ts`, `test/conflicts.browser.test.ts`, `test/storage.browser.test.ts`, and `test/sync.browser.test.ts`

## Features

| Feature | Properly tested? | Need node-only unit tests? | Need `@solidjs/testing-library`? | Need Playwright? | Notes |
|---|---:|---:|---:|---:|---|
| OPFS + File System Access storage, attach, reconnect | yes | no | no | no | covered by direct CRUD parity/unit coverage in `test/storage.test.ts` plus attach/reconnect/startup/switch/error browser coverage in `test/storage.browser.test.ts` |
| Storage status/actions single control + popover | yes | no | no | no | covered by `test/statusbar.solid.test.tsx` and `test/storage.browser.test.ts` |
| Sync button + relative-time label | yes | no | no | no | covered by `test/statusbar.solid.test.tsx` |
| Sidebar action buttons + hover tree actions | yes | no | no | no | covered by `test/notes-sidebar.solid.test.tsx` plus hover coverage in `test/storage.browser.test.ts` |
| Inline file/folder creation in the tree | yes | no | no | no | covered by `test/notes-sidebar.solid.test.tsx`, backend create contract coverage in `test/storage.test.ts`, attached-folder create coverage in `test/storage.browser.test.ts`, and OPFS sync-backed create flows in `test/sync.browser.test.ts` |
| Rename flow + backend rename + open-path remap | yes | no | no | no | covered by note-level rename logic in `test/notes.test.ts`, direct backend rename contract coverage in `test/storage.test.ts`, and browser rename/reopen coverage in `test/storage.browser.test.ts` |
| File rename basename selection + second-click rename entry | yes | no | no | no | covered in `test/storage.browser.test.ts` |
| Restore last-opened note + reconnect saved folder | yes | no | no | no | covered in `test/storage.browser.test.ts` |
| Open attached-folder note reloads or conflicts correctly after external disk edits | yes | no | no | no | covered by note-level reload/conflict coverage in `test/notes.test.ts` plus attached-folder focus-triggered reload/conflict coverage in `test/storage.browser.test.ts` |
| Auto-sync after saves/mutations | yes | no | no | no | covered in `test/sync.browser.test.ts` for save/create/folder-create/rename/delete/manual-save wiring, conflict short-circuits, and dirty-state clearing |
| Eager sync on startup/focus/visibility/online/polling | yes | no | no | no | covered in `test/sync.browser.test.ts` for startup, focus/visibility/online, hidden-state suppression, visible-only polling, manifest fallback, and cooldown dedupe, plus unresolved-conflict suppression in `test/conflicts.browser.test.ts` |
| Manifest precheck when locally clean | yes | no | no | no | covered in `test/sync.test.ts` |
| Conflict detection + explicit choices + no auto conflict file | yes | no | no | no | local conflict helpers are unit-tested and remote end-user flows are covered in `test/conflicts.browser.test.ts` |
| Non-blocking conflict indicators in status bar/tree popovers | yes | no | no | no | covered in `test/conflicts.browser.test.ts` for status bar, tree popover, unresolved editing, and cleanup |
| Monaco diff workflow + responsive labels + diff toolbar/source-version actions | yes | no | no | no | covered in `test/conflicts.browser.test.ts` including re-entry, resolution actions, and narrow-viewport labels |

## Feature Explainers

### OPFS + File System Access storage, attach, reconnect

- Test: CRUD parity in both backends, attach/reconnect/switch flows, granted vs prompt permission states, and startup restore after persisted settings.
- Read: `web/app/storage.ts`, `web/storage/file-system-access.ts`, `web/storage/opfs.ts`, `web/storage/metadata.ts`, `web/storage/types.ts`, `test/storage.test.ts`.
- Status: covered by direct CRUD parity and storage edge-case coverage in `test/storage.test.ts` plus attach/reconnect/startup/switch/error browser coverage in `test/storage.browser.test.ts`.

### Storage status/actions single control + popover

- Test: storage button label state, popover actions, disabled states, reconnect visibility, and callback wiring.
- Read: `web/app/StatusBar.tsx`, `web/app/StatusBar.css`, `web/App.tsx`, `web/app/storage.ts`.
- Status: covered by `test/statusbar.solid.test.tsx` plus storage popover browser coverage in `test/storage.browser.test.ts`.

### Sync button + relative-time label

- Test: relative label formatting over time, busy/disabled states while syncing, tooltip timestamp, and manual sync button wiring.
- Read: `web/app/StatusBar.tsx`, `web/app/StatusBar.css`, `web/App.tsx`, `web/app/sync.ts`.
- Status: covered in `test/statusbar.solid.test.tsx`.

### Sidebar action buttons + hover tree actions

- Test: header actions when storage is ready or missing, file vs folder hover actions, delete/rename/create wiring, and correct open behavior.
- Read: `web/app/NotesSidebar.tsx`, `web/app/FileTree.tsx`, `web/app/FileTree.css`, `web/notes/tree.ts`, `web/App.tsx`.
- Status: covered by `test/notes-sidebar.solid.test.tsx` plus hover browser coverage in `test/storage.browser.test.ts`.

### Inline file/folder creation in the tree

- Test: root vs folder insertion, enter and blur submit, escape cancel, inline validation messages, and successful refresh/open behavior.
- Read: `web/app/NotesSidebar.tsx`, `web/app/FileTree.tsx`, `web/app/notes.ts`, `web/notes/paths.ts`, `web/app/FileTree.css`, `test/notes.test.ts`.
- Status: covered by `test/notes-sidebar.solid.test.tsx` for inline create flows, `test/storage.test.ts` for backend create behavior in both storage backends, `test/storage.browser.test.ts` for attached-folder create/open behavior, and `test/sync.browser.test.ts` for sync-backed note/folder creation.

### Rename flow + backend rename + open-path remap

- Test: file and folder rename in both backends, descendant remapping, open-note remapping, invalid names, duplicate targets, no-op rename, and post-rename refresh.
- Read: `web/app/notes.ts`, `web/storage/file-system-access.ts`, `web/storage/opfs.ts`, `web/storage/types.ts`, `web/notes/paths.ts`, `test/notes.test.ts`.
- Status: covered by `test/notes.test.ts` for note-level remapping and validation, `test/storage.test.ts` for direct backend rename behavior in both storage backends, and `test/storage.browser.test.ts` for the end-to-end rename/reopen flow.

### File rename basename selection + second-click rename entry

- Test: second-click rename entry behavior, initial selection excluding the extension for files, and focus behavior around repeated clicks.
- Read: `web/app/FileTree.tsx`, `web/app/FileTree.css`, `TODO.md`.
- Status: covered in `test/storage.browser.test.ts`.

### Restore last-opened note + reconnect saved folder

- Test: startup restore of the saved path, reconnect restoring the same path, and the editor showing the note content without needing an extra click.
- Read: `web/app/storage.ts`, `web/app/notes.ts`, `web/App.tsx`, `web/storage/metadata.ts`, `test/storage.test.ts`.
- Status: covered in `test/storage.browser.test.ts`.

### Open attached-folder note after external disk edits

- Test: when an attached-folder file changes outside the app, focus-triggered re-entry reloads the open note if the draft is unchanged and surfaces a local file conflict if the user has local edits, without overwriting the external version.
- Read: `web/App.tsx`, `web/app/notes.ts`, `web/storage/file-system-access.ts`, `test/notes.test.ts`, `test/storage.browser.test.ts`.
- Status: covered by `test/notes.test.ts` for reload-vs-conflict note logic and `test/storage.browser.test.ts` for attached-folder focus-triggered unchanged-draft reload and dirty-draft conflict behavior.

### Auto-sync after saves/mutations

- Test: save/create/rename/delete queue sync exactly once, sync is skipped when save hits a conflict, and dirty-state tracking clears only after successful full sync.
- Read: `web/App.tsx`, `web/app/sync.ts`, `web/app/notes.ts`, `test/sync.test.ts`, `test/notes.test.ts`.
- Status: covered in `test/sync.browser.test.ts`; lower-level queue logic remains covered in `test/sync.test.ts`.

### Eager sync on startup/focus/visibility/online/polling

- Test: startup full sync, lifecycle-triggered precheck sync, cooldown dedupe, visible-only polling, and suppression while a conflict is unresolved.
- Read: `web/App.tsx`, `web/app/sync.ts`, `web/app/storage.ts`, `test/sync.test.ts`.
- Status: covered in `test/sync.browser.test.ts` for startup full sync, focus/visibility/online triggers, hidden-state suppression, visible-only polling, manifest-mismatch fallback, and immediate post-startup dedupe, plus unresolved-conflict suppression in `test/conflicts.browser.test.ts`.

### Manifest precheck when locally clean

- Test: identical manifest updates only `lastSyncedAt`, differing manifest falls back to full sync, and known local changes skip the precheck.
- Read: `web/app/sync.ts`, `web/notes/sync.ts`, `web/api.ts`, `server/schemas.ts`, `test/sync.test.ts`.

### Conflict detection + explicit choices + no auto conflict file

- Test: local file conflicts, remote sync conflicts, each explicit resolution path, no automatic `*.conflict-*` creation, and multi-conflict handling.
- Read: `web/app/notes.ts`, `web/app/sync.ts`, `web/notes/sync.ts`, `server/sync.ts`, `server/schemas.ts`, `web/App.tsx`, `test/sync.test.ts`, `test/notes.test.ts`, `test/files.test.ts`.
- Status: covered by unit tests plus Playwright coverage in `test/conflicts.browser.test.ts`.

### Non-blocking conflict indicators in status bar/tree popovers

- Test: conflict message in the status bar, conflict state in the tree, identical action sets from both entry points, continued editing while unresolved, and cleanup after resolution.
- Read: `web/app/StatusBar.tsx`, `web/app/ConflictActions.tsx`, `web/app/NotesSidebar.tsx`, `web/app/FileTree.tsx`, `web/App.tsx`, `web/app/StatusBar.css`, `web/app/FileTree.css`.
- Status: covered in `test/conflicts.browser.test.ts`.

### Monaco diff workflow + responsive labels + diff toolbar/source-version actions

- Test: entering diff mode from a conflict, leaving and returning to the same unresolved conflict, switching to another note, all diff resolution actions, responsive toolbar/layout behavior, and inline vs side-by-side labels.
- Read: `web/App.tsx`, `web/app/EditorPane.tsx`, `web/app/EditorPane.css`, `web/editor/monaco.ts`, `web/editor/monaco-diff.css`, `web/app/ConflictActions.tsx`.
- Optional resource: Monaco diff editor API docs for `monaco.editor.createDiffEditor(...)`.
- Status: covered in `test/conflicts.browser.test.ts`.

## Bug Fixes

| Bug fix | Properly tested? | Need node-only unit tests? | Need `@solidjs/testing-library`? | Need Playwright? | Notes |
|---|---:|---:|---:|---:|---|
| Previously selected note showed as open but content was not loaded on startup | yes | no | no | no | covered in `test/storage.browser.test.ts` |
| Fresh-session File System Access permission error on reopen | yes | no | no | no | covered in `test/storage.browser.test.ts` |
| Inline create/rename failures should stay inline, not become global banner errors | yes | no | no | no | helper coverage remains in `test/notes.test.ts`; inline UI coverage now lives in `test/notes-sidebar.solid.test.tsx` |
| Rename validation, duplicate target, same-name no-op, open-path remap | yes | no | no | no | well covered in `test/notes.test.ts` |
| Server sync should not auto-create a conflict file | yes | no | no | no | covered in `test/sync.test.ts` |
| Sync overlap/racing | yes | no | no | no | covered in `test/sync.test.ts` |
| Cursor jumps to top while typing during sync | yes | no | no | no | covered in `test/sync.browser.test.ts` for plain-editor cursor/column/selection stability across autosave, manual save, and lifecycle sync, plus `test/conflicts.browser.test.ts` for diff-editor cursor/selection stability across responsive layout changes |
| False cloud conflict / empty diff when local already matched remote | yes | no | no | no | covered in `test/sync.test.ts` |
| Conflict persistence and back-to-back conflict state handling | yes | no | no | no | covered in `test/conflicts.browser.test.ts` including queued conflicts and re-entry |
| Clicking the status-bar conflict, leaving diff mode, and returning to normal editor after resolution | yes | no | no | no | covered in `test/conflicts.browser.test.ts` |

## Priority Gaps

1. No open coverage gaps are tracked in this audit right now.
2. If new storage, sync, or conflict behavior lands, update this file with the exact missing coverage instead of reopening removed font or diff-layout items.
