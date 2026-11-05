import { type ModelMessage, streamText } from 'ai'
import { litertlm } from 'ai-sdk-litert-lm'
import { StatusBar } from 'expo-status-bar'
import { type ComponentRef, useEffect, useRef, useState } from 'react'
import {
  KeyboardAvoidingView,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'

import { parseCheckRequest, runChecks } from './src/checks'
import { MODEL_ID } from './src/model'

const model = litertlm(MODEL_ID)

type Line = { role: 'user' | 'assistant'; text: string }

export default function App() {
  const [status, setStatus] = useState('Send a message to download the model (2 to 3 GB).')
  const [input, setInput] = useState('What can you do without a network connection?')
  const [lines, setLines] = useState<Line[]>([])
  const [busy, setBusy] = useState(false)
  const [checkLog, setCheckLog] = useState<string[]>([])
  const chat = useRef<ComponentRef<typeof ScrollView>>(null)
  const messages = useRef<ModelMessage[]>([])
  const abort = useRef<AbortController | null>(null)
  const checksRunning = useRef(false)

  // On the next frame, and again when the keyboard resizes the chat. On a Pixel, scrolling at once
  // left a one-word reply below the screen.
  const toEnd = () => requestAnimationFrame(() => chat.current?.scrollToEnd({ animated: false }))

  const startChecks = (options: Parameters<typeof runChecks>[0]) => {
    // A cold start can deliver its link twice: as the initial URL and as an event.
    if (checksRunning.current) return
    checksRunning.current = true
    setCheckLog([])
    void runChecks(options, (line) => setCheckLog((log) => [...log, line])).finally(() => {
      checksRunning.current = false
    })
  }

  useEffect(() => {
    const onUrl = (url: string | null | undefined) => {
      const request = parseCheckRequest(url)
      if (request !== undefined) startChecks(request)
    }
    void Linking.getInitialURL().then(onUrl)
    const subscription = Linking.addEventListener('url', ({ url }) => onUrl(url))
    return () => subscription.remove()
  }, [])

  const send = async () => {
    const text = input.trim()
    if (text.length === 0 || busy) return
    setBusy(true)
    setInput('')
    setLines((all) => [...all, { role: 'user', text }, { role: 'assistant', text: '' }])
    // Added to the history only when the reply arrives, so a failed call can be sent again.
    const next: ModelMessage[] = [...messages.current, { role: 'user', content: text }]
    abort.current = new AbortController()

    try {
      setStatus('Loading the model...')
      await model.prepare({
        onProgress: ({ fraction }) => {
          if (fraction !== undefined) setStatus(`Downloading ${Math.round(fraction * 100)}%`)
        },
        abortSignal: abort.current.signal,
      })
      setStatus('Generating...')

      const result = streamText({
        model,
        messages: next,
        abortSignal: abort.current.signal,
        onError: ({ error }) => setStatus(`Failed: ${String(error)}`),
      })
      for await (const delta of result.textStream) {
        setLines((all) => {
          const copy = [...all]
          const last = copy[copy.length - 1] as Line
          copy[copy.length - 1] = { ...last, text: last.text + delta }
          return copy
        })
      }
      messages.current = [...next, ...(await result.response).messages]
      setStatus(abort.current.signal.aborted ? 'Stopped' : 'Ready')
    } catch (error) {
      setStatus(abort.current.signal.aborted ? 'Stopped' : `Failed: ${String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior="padding">
      <StatusBar style="dark" />
      <Text style={styles.title}>LiteRT-LM with the AI SDK</Text>
      <Text style={styles.status}>{status}</Text>

      <ScrollView
        ref={chat}
        style={styles.chat}
        contentContainerStyle={styles.chatContent}
        onContentSizeChange={toEnd}
        onLayout={toEnd}
      >
        {lines
          .filter((line) => line.text.length > 0)
          .map((line, index) => (
            <Text
              key={index}
              style={line.role === 'user' ? styles.user : styles.assistant}
            >
              {line.text}
            </Text>
          ))}
        {checkLog.map((line, index) => (
          <Text key={`check-${index}`} style={styles.check}>
            {line}
          </Text>
        ))}
      </ScrollView>

      <TextInput
        style={styles.input}
        value={input}
        onChangeText={setInput}
        placeholder="Message"
        multiline
      />
      <View style={styles.row}>
        <Pressable style={styles.button} onPress={send} disabled={busy}>
          <Text style={styles.buttonText}>Send</Text>
        </Pressable>
        <Pressable style={styles.button} onPress={() => abort.current?.abort()} disabled={!busy}>
          <Text style={styles.buttonText}>Stop</Text>
        </Pressable>
        <Pressable style={styles.button} onPress={() => startChecks({})} disabled={busy}>
          <Text style={styles.buttonText}>Run checks</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingTop: 56, paddingHorizontal: 16, backgroundColor: '#fff' },
  title: { fontSize: 20, fontWeight: '600' },
  status: { color: '#555', marginTop: 4, marginBottom: 8 },
  chat: { flex: 1 },
  chatContent: { gap: 8, paddingVertical: 8 },
  user: { alignSelf: 'flex-end', backgroundColor: '#e6f4fe', padding: 8, borderRadius: 8 },
  assistant: { alignSelf: 'flex-start', backgroundColor: '#f2f2f2', padding: 8, borderRadius: 8 },
  check: { fontFamily: 'monospace', fontSize: 11 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 8, minHeight: 44 },
  row: { flexDirection: 'row', gap: 8, marginTop: 8, marginBottom: 24 },
  button: { backgroundColor: '#1a73e8', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8 },
  buttonText: { color: '#fff', fontWeight: '600' },
})
