export function writeLogFile(_lines: string[]): void {}

export function documentsPath(): string | undefined {
  return undefined
}

/** The README's lines that free a browser's downloads. Returns the models they removed. */
export async function removeKeptModels(): Promise<string[] | undefined> {
  const root = await navigator.storage.getDirectory()
  const directory = await root.getDirectoryHandle('litert-lm-models')
  const names: string[] = []
  for await (const handle of directory.values()) {
    if (handle.name.endsWith('.litertlm') && (await (handle as FileSystemFileHandle).getFile()).size > 0) {
      names.push(handle.name)
    }
  }
  await root.removeEntry('litert-lm-models', { recursive: true })
  return names
}
