/** Keep the checks' log where a release build can be read: an iOS one sends console output only to the system log. */
export function writeLogFile(lines: string[]): void

/** The app's Documents directory on a phone. */
export function documentsPath(): string | undefined

/** In a browser, remove the kept downloads and say how many there were. A phone returns undefined. */
export function removeKeptModels(): Promise<string[] | undefined>
