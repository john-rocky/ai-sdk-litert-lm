import { File, Paths } from 'expo-file-system'

/** The checks' log, at Documents/checks.log in the app's container. */
export function writeLogFile(lines: string[]): void {
  try {
    new File(Paths.document, 'checks.log').write(`${lines.join('\n')}\n`)
  } catch (error) {
    console.warn(`Could not write the log file: ${String(error)}`)
  }
}

/** The app's Documents directory, for files a test copies onto the phone. */
export function documentsPath(): string | undefined {
  return decodeURI(Paths.document.uri).replace(/^file:\/\//, '').replace(/\/$/, '')
}

export async function removeKeptModels(): Promise<string[] | undefined> {
  return undefined
}
