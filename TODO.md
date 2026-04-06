- [x] use Codicons for app icons
- [x] "Storage: <folder name>" + attach folder + use opfs => should all combine in a single button
- [x] "last sync <date>" + sync button => should combine in a single button
- [x] date should display as human readable using `Intl.RelativeTimeFormat`
- [x] new note / new folder / delete note => should all be buttons in the sidebar. (delete => appears when hovering folder or file, new note / new folder => appears on hover of a folder, and in the header)
- [x] improve file/folder creation flow: do not use the native prompt, instead show an input *where the new file/folder should be* (so if i click "new note" on a folder, it should show an input in the folder, and if i click "new note" in the header, it should show an input in the root). This input should be the size and appearance of a normal file/folder name, and when i submit it (by pressing enter or blurring the input), it should create the file/folder with that name.
- [x] rename button => appears on hover of a folder / file
- [x] editor-header isn't useful, remove it
- [x] use monaspace font
- [x] can we auto-sync? (once on page visibility visible, and on every save? or is there a more logical approach?)
- [x] in the diff editor, can we add some text above the left and right halves to indicate "this is the state from the cloud" and "this is the current draft" (text to improve)? Since both halves are resizable, this text would have to either be rendered in solid, but aligned left and aligned right to avoid a resize of the diff messing it up, or rendered in monaco itself (but i don't know how customizable monaco is). Rendered in the editor is prefered if possible. Also on narrow screens, the diff is shown inline and not side-by-side, so we need to handle that case too
- [x] there are situations where i'm typing and my cursor changes position. It seems sometimes the sync (maybe?) causes this change, even in situations where my note is in the latest version. In those cases the cursor is always reset to the topmost position. I think it happens if i edit the note *during* a sync.
- [x] is the "Dark 2026" theme available on monaco editor? if yes use it
- [x] when i create a new note in an empty folder, it creates the note i want AND an `untitled.md` note. It doesn't happen if i create it at the root, only inside a folder *that doesn't already have* an `untitled.md` note.
- [x] "clicking a second time to enter rename mode" should only apply to files, not folders
- [x] when creating a new file we prefill the input with "untitled.md" and the entire input is pre-selected. We would like to only pre-select the "untitled" without the extension, so creating a new note is faster
- [x] add a cmd+alt+N keyboard shortcut that will create a new note in the same folder that we are already in (or fallback to the root), it should immediately focus the input of the new note's name, like if we had clicked on the "new note" button
- [x] in the file tree, if a folder is closed, but contains files that have conflicts, there should be an indication on the folder
- [ ] when creating a new note, if i submit the file name with "enter", i should automatically be focused onto the editor
- [ ] all (most?) buttons should have a keyboard shortcut (use tanstack/hotkeys)
- [ ] if i'm editing a note in a separate editor (when using file system API) and the same note is open in this app, it should update in the app (currently, after editing if I go back to the app, it seems to remove all the changes I made on the external editor, this only happens if the note was open in both, but works fine if i had another note open in this app)
- [ ] When I switch from OPFS to the file system API (and there are existing notes in the OPFS) I should be asked if i want to transfer existing notes to the file system
- [ ] we should be able to drag a file to move it to a different folder, droping on a folder moves it there, hovering (while dragging) on a folder for 1 second should open the folder, and dropping on empty space should move it to the root
- [ ] opening a folder should not open all the subfolders. The minimal fix is to *only* open the folder that was clicked, and keep subfolders closed. Maybe a better fix would be to *remember* the last state (open/close) the subfolders were in before we closed the parent, and restore that state when we re-open the parent
- [ ] we will need to figure out how to support images (and other attachments)
- [ ] SSO (see ~/web/foo/index.js for how to use our own internal sso, and ~/web/foo/package.json for how to install it)
- [ ] if we added a "command palette", what could we put in it? i like the idea




font settings
```json
	"editor.fontSize": 12,
	"editor.lineHeight": 1.6,
	"editor.fontWeight": 300,
	"editor.fontFamily": "'Monaspace Neon', monospace",
	"editor.fontLigatures": "'calt', 'liga', 'ss01', 'ss02', 'ss03', 'ss04', 'ss05', 'ss06', 'ss07', 'ss08', 'ss09', 'cv01' 4, 'cv31' 0",
```
