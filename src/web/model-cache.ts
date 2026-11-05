import { createAbortError, errorMessage, LiteRTLMError } from '../shared/errors.js'
import type { LiteRTLMProgress } from '../shared/types.js'

/** The directory in the origin private file system that holds downloaded models. */
export const MODEL_CACHE_NAME = 'litert-lm-models'

export interface CachedModel {
  file: Blob
  /** Forget the file, once it has turned out not to be a model. */
  evict(): Promise<void>
}

/** Where a model's bytes come from. The hash, when known, names the file: a new commit that leaves it alone costs nothing. */
export interface ModelLocation {
  url: string
  sha256?: string
}

interface DownloadOptions {
  accessToken?: string
  onProgress?: (progress: LiteRTLMProgress) => void
  signal?: AbortSignal
}

async function openDirectory(): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    const root = await navigator.storage.getDirectory()
    return await root.getDirectoryHandle(MODEL_CACHE_NAME, { create: true })
  } catch {
    return undefined
  }
}

/** A hash of the text, which is always a valid file name. */
async function nameFor(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const modelFileName = async (location: ModelLocation): Promise<string> =>
  `${location.sha256 ?? (await nameFor(location.url))}.litertlm`

/** The kept file, if there is one. A download in progress or cut short leaves an empty file. */
async function readKept(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<File | undefined> {
  try {
    const file = await (await directory.getFileHandle(name)).getFile()
    return file.size > 0 ? file : undefined
  } catch {
    return undefined
  }
}

function evictor(directory: FileSystemDirectoryHandle, name: string): () => Promise<void> {
  return async () => {
    await directory.removeEntry(name).catch(() => {})
  }
}

/**
 * Note where a model id's bytes are, for the day the Hub can't be asked. Failing to is not an
 * error: the model just needs a network the next time.
 */
export async function rememberLocation(modelKey: string, location: ModelLocation): Promise<void> {
  try {
    const directory = await openDirectory()
    if (directory === undefined) return
    const handle = await directory.getFileHandle(`${await nameFor(modelKey)}.json`, { create: true })
    const writable = await handle.createWritable()
    await writable.write(JSON.stringify(location))
    await writable.close()
  } catch (error) {
    console.warn(`Could not note where the model is: ${errorMessage(error)}`)
  }
}

/** The model a model id gave the last time, if its file is still here. */
export async function recallKept(modelKey: string): Promise<CachedModel | undefined> {
  const directory = await openDirectory()
  if (directory === undefined) return undefined
  try {
    const handle = await directory.getFileHandle(`${await nameFor(modelKey)}.json`)
    const location = JSON.parse(await (await handle.getFile()).text()) as ModelLocation
    const name = await modelFileName(location)
    const file = await readKept(directory, name)
    return file !== undefined ? { file, evict: evictor(directory, name) } : undefined
  } catch {
    return undefined
  }
}

/** Tries in a row that get no further before a download gives up: about 30 s of waiting. */
const MAX_STALLED_TRIES = 6
const FIRST_RETRY_DELAY_MS = 1000

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

async function request(url: string, from: number, options: DownloadOptions): Promise<Response> {
  const headers: Record<string, string> = {}
  if (options.accessToken !== undefined && options.accessToken !== '') {
    headers.Authorization = `Bearer ${options.accessToken}`
  }
  if (from > 0) headers.Range = `bytes=${from}-`
  let response: Response
  try {
    response = await fetch(url, { headers, signal: options.signal })
  } catch (error) {
    throw new LiteRTLMError(
      'DOWNLOAD_FAILED',
      `Could not download ${url}: ${errorMessage(error)}`,
      error,
    )
  }
  if (!response.ok || response.body === null) {
    const missing = response.status === 401 || response.status === 403 || response.status === 404
    throw new LiteRTLMError(
      missing ? 'MODEL_NOT_FOUND' : 'DOWNLOAD_FAILED',
      `Could not download ${url}: HTTP ${response.status}. Check the name; a gated or private model needs accessToken.`,
    )
  }
  return response
}

/** Whether a response to a range request is the rest of the file a download began with. */
function continuesFile(
  response: Response,
  received: number,
  total: number | undefined,
  etag: string | null,
): boolean {
  if (response.status !== 206) return false
  const range = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(response.headers.get('Content-Range') ?? '')
  if (range === null || Number(range[1]) !== received) return false
  if (total !== undefined && range[2] !== '*' && Number(range[2]) !== total) return false
  return etag === null || response.headers.get('ETag') === etag
}

/** Write a response to the file. A failed read is a download failure, a failed write not. */
async function copyBody(
  response: Response,
  url: string,
  writable: FileSystemWritableFileStream,
  onBytes: (bytes: number) => void,
): Promise<void> {
  const reader = (response.body as ReadableStream<Uint8Array<ArrayBuffer>>).getReader()
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array<ArrayBuffer>>
    try {
      chunk = await reader.read()
    } catch (error) {
      throw new LiteRTLMError(
        'DOWNLOAD_FAILED',
        `Could not download ${url}: ${errorMessage(error)}`,
        error,
      )
    }
    if (chunk.done) return
    await writable.write(chunk.value)
    onBytes(chunk.value.byteLength)
  }
}

/**
 * The model from the origin private file system, downloaded the first time. The runtime alone
 * downloads the whole file on every load and reports no progress.
 *
 * A dropped connection is picked up where it stopped. A download can take minutes, and a few
 * GB is a lot to start over.
 *
 * Returns undefined when the file can't be kept: this file system exists only in a secure
 * context, and a write can fail for lack of quota, as it did at about 2 GB in an off-the-record
 * Chrome context. The runtime can then read the URL itself.
 */
export async function loadFromCache(
  location: ModelLocation,
  options: DownloadOptions,
): Promise<CachedModel | undefined> {
  const directory = await openDirectory()
  if (directory === undefined) return undefined
  const { url } = location
  const name = await modelFileName(location)
  const evict = evictor(directory, name)

  const kept = await readKept(directory, name)
  if (kept !== undefined) return { file: kept, evict }

  let writable: FileSystemWritableFileStream | undefined
  try {
    let received = 0
    let total: number | undefined
    let etag: string | null = null
    let stalledTries = 0
    for (;;) {
      const before = received
      try {
        let response = await request(url, received, options)
        if (received > 0 && !continuesFile(response, received, total, etag)) {
          // Not the rest of the same file: it changed, or the server has no ranges.
          received = 0
          await writable?.truncate(0)
          if (response.status === 206) {
            await response.body?.cancel()
            response = await request(url, 0, options)
          }
        }
        if (received === 0) {
          total = Number(response.headers.get('Content-Length')) || undefined
          etag = response.headers.get('ETag')
        }
        // The file stays empty until the writable closes, so a cut-off download is never read.
        writable ??= await (await directory.getFileHandle(name, { create: true })).createWritable()
        await copyBody(response, url, writable, (bytes) => {
          received += bytes
          options.onProgress?.(total !== undefined ? { fraction: received / total } : {})
        })
        break
      } catch (error) {
        const lostConnection = LiteRTLMError.isInstance(error) && error.code === 'DOWNLOAD_FAILED'
        if (!lostConnection || options.signal?.aborted) throw error
        if (received === total) break // Every byte arrived before the connection went.
        if (received === 0) throw error // Nothing to save: the caller can simply try again.
        stalledTries = received > before ? 1 : stalledTries + 1
        if (stalledTries >= MAX_STALLED_TRIES) throw error
        await wait(FIRST_RETRY_DELAY_MS * 2 ** (stalledTries - 1), options.signal)
      }
    }
    await writable?.close()
    return { file: await (await directory.getFileHandle(name)).getFile(), evict }
  } catch (error) {
    await writable?.abort().catch(() => {})
    await evict()
    if (options.signal?.aborted) throw createAbortError()
    if (LiteRTLMError.isInstance(error)) throw error
    console.warn(`Could not keep ${url}, so it loads from the network each time: ${errorMessage(error)}`)
    return undefined
  }
}
