- [x] use Codicons for app icons
- [x] "Storage: <folder name>" + attach folder + use opfs => should all combine in a single button
- [x] "last sync <date>" + sync button => should combine in a single button
- [x] date should display as human readable using `Intl.RelativeTimeFormat`
- [ ] new note / new folder / delete note => should all be buttons in the sidebar. (delete => appears when hovering folder or file, new note / new folder => appears on hover of a folder, and in the header)
- [ ] rename button => appears on hover of a folder / file
- [ ] editor-header isn't useful, remove it
- [ ] use monaspace font
- [ ] can we auto-sync? (once on page visibility visible, and on every save)
- [ ] all (most?) buttons should have a keyboard shortcut (use tanstack/hotkeys)
- [ ] if i'm editing a note in a separate editor (when using file system API) and the same note is open in this app, it should update in the app (currently, after editing if I go back to the app, it seems to remove all the changes I made on the external editor, this only happens if the note was open in both, but works fine if i had another note open in this app)
- [ ] When I switch from OPFS to the file system API (and there are existing notes in the OPFS) I should be asked if i want to transfer existing notes to the file system
- [ ] we will need to figure out how to support images (and other attachments)
- [ ] SSO (see ~/web/foo/index.js for how to use our own internal sso, and ~/web/foo/package.json for how to install it)




font settings
```json
	"editor.fontSize": 12,
	"editor.lineHeight": 1.6,
	"editor.fontWeight": 300,
	"editor.fontFamily": "'Monaspace Neon', monospace",
	"editor.fontLigatures": "'calt', 'liga', 'ss01', 'ss02', 'ss03', 'ss04', 'ss05', 'ss06', 'ss07', 'ss08', 'ss09', 'cv01' 4, 'cv31' 0",
```
