import { Codicon } from './Codicon.tsx'

export type ConflictActionLabels = {
  acceptTheirs: string
  resolveInDiff: string
  saveMine: string
  saveMineSeparately: string
}

export function ConflictActions(props: {
  labels: ConflictActionLabels
  popoverId?: string
  onAcceptTheirs(): void
  onResolveInDiff(): void
  onSaveMine(): void
  onSaveMineSeparately(): void
}) {
  const dismissProps =
    props.popoverId === undefined
      ? {}
      : {
          popovertarget: props.popoverId,
          popovertargetaction: 'hide' as const,
        }

  return (
    <>
      <button type="button" {...dismissProps} onClick={props.onSaveMine}>
        <Codicon name="save" />
        <span>{props.labels.saveMine}</span>
      </button>
      <button type="button" {...dismissProps} onClick={props.onAcceptTheirs}>
        <Codicon name="check" />
        <span>{props.labels.acceptTheirs}</span>
      </button>
      <button type="button" {...dismissProps} onClick={props.onSaveMineSeparately}>
        <Codicon name="copy" />
        <span>{props.labels.saveMineSeparately}</span>
      </button>
      <button type="button" {...dismissProps} onClick={props.onResolveInDiff}>
        <Codicon name="split-horizontal" />
        <span>{props.labels.resolveInDiff}</span>
      </button>
    </>
  )
}
