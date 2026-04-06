# Test Coverage Audit

Current test stack:
- Node-only Vitest tests in `test/files.test.ts`, `test/notes.test.ts`, `test/storage.test.ts`, `test/sync.test.ts`
- No `@solidjs/testing-library` tests
- Playwright browser tests in `test/playwright-demo.browser.test.ts` and `test/conflicts.browser.test.ts`

## Features

| Feature | Properly tested? | Need node-only unit tests? | Need `@solidjs/testing-library`? | Need Playwright? | Notes |
|---|---:|---:|---:|---:|---|
| OPFS + File System Access storage, attach, reconnect | no | yes | no | yes | `bootstrapWorkspace`/`reconnectFolder` are tested, but real storage operations and browser permission flows are not |
| Storage status/actions single control + popover | no | no | yes | yes | UI-only behavior |
| Sync button + relative-time label | no | yes | yes | no | formatter/rendering is untested |
| Sidebar action buttons + hover tree actions | no | no | yes | yes | hover/action wiring is untested |
| Inline file/folder creation in the tree | no | yes | yes | yes | only error-path logic is covered now |
| Rename flow + backend rename + open-path remap | no | yes | yes | yes | note-level rename logic is partly tested; backend implementations and UI are not |
| File rename basename selection + second-click rename entry | no | no | no | yes | selection/focus behavior is browser-only |
| Monaspace only in Monaco + Monaco worker boot | no | no | no | yes | needs real editor boot smoke |
| Restore last-opened note + reconnect saved folder | no | no | no | yes | storage bootstrap is tested, but actual startup restore in the app is not |
| Auto-sync after saves/mutations | no | no | no | yes | sync queue logic is tested, App-level trigger wiring is not |
| Eager sync on startup/focus/visibility/online/polling | no | no | no | yes | browser lifecycle/timer behavior |
| Manifest precheck when locally clean | yes | no | no | no | covered in `test/sync.test.ts` |
| Conflict detection + explicit choices + no auto conflict file | yes | no | no | no | local conflict helpers are unit-tested and remote end-user flows are covered in `test/conflicts.browser.test.ts` |
| Non-blocking conflict indicators in status bar/tree popovers | yes | no | no | no | covered in `test/conflicts.browser.test.ts` for status bar, tree popover, unresolved editing, and cleanup |
| Monaco diff workflow + responsive labels + diff toolbar/source-version actions | yes | no | no | no | covered in `test/conflicts.browser.test.ts` including re-entry, resolution actions, and narrow-viewport labels |

## Feature Explainers

### OPFS + File System Access storage, attach, reconnect

- Test: CRUD parity in both backends, attach/reconnect/switch flows, granted vs prompt permission states, and startup restore after persisted settings.
- Read: `web/app/storage.ts`, `web/storage/file-system-access.ts`, `web/storage/opfs.ts`, `web/storage/metadata.ts`, `web/storage/types.ts`, `test/storage.test.ts`.

### Storage status/actions single control + popover

- Test: storage button label state, popover actions, disabled states, reconnect visibility, and callback wiring.
- Read: `web/app/StatusBar.tsx`, `web/app/StatusBar.css`, `web/App.tsx`, `web/app/storage.ts`.

### Sync button + relative-time label

- Test: relative label formatting over time, busy/disabled states while syncing, tooltip timestamp, and manual sync button wiring.
- Read: `web/app/StatusBar.tsx`, `web/app/StatusBar.css`, `web/App.tsx`, `web/app/sync.ts`.

### Sidebar action buttons + hover tree actions

- Test: header actions when storage is ready or missing, file vs folder hover actions, delete/rename/create wiring, and correct open behavior.
- Read: `web/app/NotesSidebar.tsx`, `web/app/FileTree.tsx`, `web/app/FileTree.css`, `web/notes/tree.ts`, `web/App.tsx`.

### Inline file/folder creation in the tree

- Test: root vs folder insertion, enter and blur submit, escape cancel, inline validation messages, and successful refresh/open behavior.
- Read: `web/app/NotesSidebar.tsx`, `web/app/FileTree.tsx`, `web/app/notes.ts`, `web/notes/paths.ts`, `web/app/FileTree.css`, `test/notes.test.ts`.

### Rename flow + backend rename + open-path remap

- Test: file and folder rename in both backends, descendant remapping, open-note remapping, invalid names, duplicate targets, no-op rename, and post-rename refresh.
- Read: `web/app/notes.ts`, `web/storage/file-system-access.ts`, `web/storage/opfs.ts`, `web/storage/types.ts`, `web/notes/paths.ts`, `test/notes.test.ts`.

### File rename basename selection + second-click rename entry

- Test: second-click rename entry behavior, initial selection excluding the extension for files, and focus behavior around repeated clicks.
- Read: `web/app/FileTree.tsx`, `web/app/FileTree.css`, `TODO.md`.

### Monaspace only in Monaco + Monaco worker boot

- Test: normal editor and diff editor both boot with Monaco, worker wiring does not fail, Monaco uses Monaspace, and the rest of the UI keeps the system font.
- Read: `web/editor/monaco.ts`, `web/editor/monaco-font.css`, `web/index.css`, `web/editor/fonts/README.md`, `package.json`.

### Restore last-opened note + reconnect saved folder

- Test: startup restore of the saved path, reconnect restoring the same path, and the editor showing the note content without needing an extra click.
- Read: `web/app/storage.ts`, `web/app/notes.ts`, `web/App.tsx`, `web/storage/metadata.ts`, `test/storage.test.ts`.

### Auto-sync after saves/mutations

- Test: save/create/rename/delete queue sync exactly once, sync is skipped when save hits a conflict, and dirty-state tracking clears only after successful full sync.
- Read: `web/App.tsx`, `web/app/sync.ts`, `web/app/notes.ts`, `test/sync.test.ts`, `test/notes.test.ts`.

### Eager sync on startup/focus/visibility/online/polling

- Test: startup full sync, lifecycle-triggered precheck sync, cooldown dedupe, visible-only polling, and suppression while a conflict is unresolved.
- Read: `web/App.tsx`, `web/app/sync.ts`, `web/app/storage.ts`, `test/sync.test.ts`.

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
| Previously selected note showed as open but content was not loaded on startup | no | no | no | yes | startup/Monaco mount race |
| Fresh-session File System Access permission error on reopen | no | no | no | yes | current unit tests cover the decision logic, not the real browser failure mode |
| Inline create/rename failures should stay inline, not become global banner errors | no | no | yes | no | current tests only prove the banner is cleared |
| Rename validation, duplicate target, same-name no-op, open-path remap | yes | no | no | no | well covered in `test/notes.test.ts` |
| Server sync should not auto-create a conflict file | yes | no | no | no | covered in `test/sync.test.ts` |
| Sync overlap/racing | yes | no | no | no | covered in `test/sync.test.ts` |
| Cursor jumps to top while typing during sync | no | no | no | yes | cursor/selection stability needs a real editor |
| False cloud conflict / empty diff when local already matched remote | yes | no | no | no | covered in `test/sync.test.ts` |
| Conflict persistence and back-to-back conflict state handling | yes | no | no | no | covered in `test/conflicts.browser.test.ts` including queued conflicts and re-entry |
| Clicking the status-bar conflict, leaving diff mode, and returning to normal editor after resolution | yes | no | no | no | covered in `test/conflicts.browser.test.ts` |
| Diff toolbar/layout regressions: overlap, 5px editor collapse, intent colors | no | no | no | yes | layout/responsive CSS needs browser coverage |

## Priority Gaps

1. Playwright for OPFS/File System Access startup/reconnect flows
2. Solid integration tests for `StatusBar`, `FileTree`, and `NotesSidebar`
