# Storage Browser Tests

Next necessary browser tests after the startup/reconnect suite in `test/storage.browser.test.ts`:

- [x] Directory CRUD smoke: attach an empty folder, create a note, edit it, verify the file content in directory storage, and confirm the same note restores after reopening the app. Covered by `test/storage.browser.test.ts`.
- [x] Attach permission denied: starting from OPFS with an existing open note, attempt `Attach folder`, deny access, and confirm the app stays on the current OPFS workspace with an error. Covered by `test/storage.browser.test.ts`.
- [x] Picker cancel: starting from OPFS, cancel `Attach folder`, and confirm storage, open note, and reconnect state do not change. Covered by `test/storage.browser.test.ts`.
- [x] Switch to OPFS: start from an attached folder, choose `Use OPFS`, and confirm the backend changes, directory notes are no longer shown, and the OPFS backend persists after reopening. Covered by `test/storage.browser.test.ts`.
- [x] Directory delete flow: delete a note from an attached folder and verify the file disappears from directory storage and the app refreshes to the correct remaining selection. Covered by `test/storage.browser.test.ts`.
- [ ] Directory rename flow: rename the open note in an attached folder, verify the old path is gone, the new path exists, and reopening restores the renamed path.
- [ ] Missing saved path fallback: persist a `lastOpenedPath`, remove that file outside the app, reopen, and confirm startup falls back to another file or the empty state instead of showing a stale selection.
- [ ] Unsupported browser attach flow: remove `showDirectoryPicker`, invoke `Attach folder`, and confirm the app shows the unsupported-browser error without changing storage.
