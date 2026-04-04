import codiconSpriteUrl from '@vscode/codicons/dist/codicon.svg?url'
import type IconMeta from '@vscode/codicons/dist/metadata.json'

export type CodiconName = keyof typeof IconMeta

export function Codicon(props: { name: CodiconName }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <use href={`${codiconSpriteUrl}#${props.name}`} />
    </svg>
  )
}
