import definitions from 'seti-icons/lib/definitions.json'
import icons from 'seti-icons/lib/icons.json'

type SetiIconName = keyof typeof icons
type SetiDefinition = readonly [SetiIconName, string]

type SetiDefinitions = {
  files: Record<string, SetiDefinition>
  extensions: Record<string, SetiDefinition>
  partials: Array<readonly [string, SetiDefinition]>
  default: SetiDefinition
}

function toSetiDefinition([iconName, color]: readonly string[]): SetiDefinition {
  return [iconName as SetiIconName, color]
}

function toSetiPartial([partial, definition]: readonly (string | string[])[]): readonly [string, SetiDefinition] {
  return [String(partial), toSetiDefinition(definition as string[])]
}

const setiDefinitions = {
  files: Object.fromEntries(Object.entries(definitions.files).map(([fileName, definition]) => [fileName, toSetiDefinition(definition)])),
  extensions: Object.fromEntries(
    Object.entries(definitions.extensions).map(([extension, definition]) => [extension, toSetiDefinition(definition)]),
  ),
  partials: definitions.partials.map(toSetiPartial),
  default: toSetiDefinition(definitions.default),
} satisfies SetiDefinitions

function getBaseName(path: string): string {
  const segments = path.split('/').filter((segment) => segment.length > 0)
  return segments.at(-1) ?? path
}

function getSetiDefinition(fileName: string): SetiDefinition {
  const fileDefinition = setiDefinitions.files[fileName]

  if (fileDefinition !== undefined) {
    return fileDefinition
  }

  const firstExtensionIndex = fileName.indexOf('.')

  if (firstExtensionIndex >= 0) {
    let extension = fileName.slice(firstExtensionIndex)

    while (extension.length > 0) {
      const extensionDefinition = setiDefinitions.extensions[extension]

      if (extensionDefinition !== undefined) {
        return extensionDefinition
      }

      const nextExtensionIndex = extension.indexOf('.', 1)

      if (nextExtensionIndex < 0) {
        break
      }

      extension = extension.slice(nextExtensionIndex)
    }
  }

  for (const [partial, partialDefinition] of setiDefinitions.partials) {
    if (fileName.includes(partial)) {
      return partialDefinition
    }
  }

  return setiDefinitions.default
}

function getSetiIconSvg(path: string): string {
  const [iconName] = getSetiDefinition(getBaseName(path))
  return icons[iconName]
}

export function SetiIcon(props: { fileName: string }) {
  return <span class="seti-icon" innerHTML={getSetiIconSvg(props.fileName)} />
}
