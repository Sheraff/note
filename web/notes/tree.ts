import { comparePaths } from '../../server/files.ts'
import { getName, normalizeNotePath } from './paths.ts'

export type ListedEntry = {
  kind: 'directory' | 'file'
  path: string
}

export type TreeNode = {
  kind: 'directory' | 'file'
  path: string
  name: string
  children: TreeNode[]
}

function createDirectoryNode(path: string): TreeNode {
  return {
    kind: 'directory',
    path,
    name: getName(path),
    children: [],
  }
}

function createFileNode(path: string): TreeNode {
  return {
    kind: 'file',
    path,
    name: getName(path),
    children: [],
  }
}

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes
    .map((node) => ({
      ...node,
      children: sortNodes(node.children),
    }))
    .sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === 'directory' ? -1 : 1
      }

      return comparePaths(left.path, right.path)
    })
}

export function buildTree(entries: ListedEntry[]): TreeNode[] {
  const normalizedEntries = entries
    .map((entry) => ({
      ...entry,
      path: normalizeNotePath(entry.path),
    }))
    .filter((entry) => entry.path.length > 0)

  const directoryPaths = new Set<string>()
  const filePaths = new Set<string>()

  for (const entry of normalizedEntries) {
    const segments = entry.path.split('/')

    for (let index = 1; index < segments.length; index += 1) {
      directoryPaths.add(segments.slice(0, index).join('/'))
    }

    if (entry.kind === 'directory') {
      directoryPaths.add(entry.path)
      continue
    }

    filePaths.add(entry.path)
  }

  const nodeByPath = new Map<string, TreeNode>()
  const rootNodes: TreeNode[] = []
  const orderedDirectories = [...directoryPaths].sort(comparePaths)

  for (const path of orderedDirectories) {
    nodeByPath.set(path, createDirectoryNode(path))
  }

  for (const path of [...filePaths].sort(comparePaths)) {
    nodeByPath.set(path, createFileNode(path))
  }

  for (const node of nodeByPath.values()) {
    const separatorIndex = node.path.lastIndexOf('/')

    if (separatorIndex < 0) {
      rootNodes.push(node)
      continue
    }

    const parentPath = node.path.slice(0, separatorIndex)
    const parent = nodeByPath.get(parentPath)

    if (parent === undefined) {
      rootNodes.push(node)
      continue
    }

    parent.children.push(node)
  }

  return sortNodes(rootNodes)
}
