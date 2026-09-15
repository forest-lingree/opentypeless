import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as tauri from '../../lib/tauri'
import { useAppStore } from '../../stores/appStore'
import { AgentMaestroFields } from '../AgentMaestroFields'

vi.mock('../../lib/tauri', () => ({
  readCredential: vi.fn(),
  setCredential: vi.fn(),
  fetchLlmModels: vi.fn(),
  benchLlmConnection: vi.fn(),
  testLlmConnection: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { count?: number }) =>
      ({
        'settings.apiKey': 'API Key',
        'settings.model': 'Model',
        'settings.baseUrl': 'Base URL',
        'settings.test': 'Test',
        'settings.fetchModels': 'Fetch models',
        'settings.connectionSuccess': 'Connection successful',
        'settings.connectionFailed': 'Connection failed',
        'settings.modelsAvailable': `${params?.count ?? 0} models available`,
        'settings.agentMaestroHint':
          'Requires VS Code, a running Agent Maestro server, and Copilot sign-in; this is not offline inference.',
        'settings.agentMaestroKeyOptional': 'optional',
        'settings.agentMaestroConfigurationRequired': 'Base URL and model are required.',
        'settings.agentMaestroCredentialPending': 'Credential is still loading or saving.',
        'settings.agentMaestroCredentialError': 'Credential storage is unavailable.',
        'settings.agentMaestroRetry': 'Retry',
        'settings.agentMaestroModelsLoading': 'Loading models…',
        'settings.agentMaestroModelsEmpty': 'No models were returned.',
      })[key] ?? key,
  }),
}))

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setMaestroConfig(
  overrides: Partial<ReturnType<typeof useAppStore.getState>['config']> = {},
) {
  useAppStore.getState().updateConfig({
    llm_provider: 'agent-maestro',
    llm_api_key: '',
    llm_base_url: 'http://127.0.0.1:23333/api/openai/v1',
    llm_model: '',
    ...overrides,
  })
}

async function renderReady(mode: 'settings' | 'onboarding' = 'settings') {
  const view = render(<AgentMaestroFields mode={mode} />)
  await waitFor(() => expect(screen.getByLabelText(/API Key/)).toBeEnabled())
  return view
}

describe('AgentMaestroFields', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState())
    setMaestroConfig()
    vi.clearAllMocks()
    vi.mocked(tauri.readCredential).mockResolvedValue(null)
    vi.mocked(tauri.setCredential).mockResolvedValue(undefined)
    vi.mocked(tauri.fetchLlmModels).mockResolvedValue([])
    vi.mocked(tauri.benchLlmConnection).mockResolvedValue(0)
    vi.mocked(tauri.testLlmConnection).mockResolvedValue(true)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it.each([
    ['settings', 'benchLlmConnection'],
    ['onboarding', 'testLlmConnection'],
  ] as const)(
    'allows a %s connection test without a key after a model is entered',
    async (mode, command) => {
      await renderReady(mode)
      const testButton = screen.getByRole('button', { name: 'Test' })
      expect(testButton).toBeDisabled()
      expect(screen.getByText('Base URL and model are required.')).toBeInTheDocument()

      fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'copilot-model' } })
      expect(testButton).toBeEnabled()
      fireEvent.click(testButton)

      await waitFor(() =>
        expect(tauri[command]).toHaveBeenCalledWith(
          '',
          'agent-maestro',
          'http://127.0.0.1:23333/api/openai/v1',
          'copilot-model',
        ),
      )
      await waitFor(() => expect(useAppStore.getState().llmTestStatus).toBe('success'))
      expect(
        screen.getByText(mode === 'settings' ? '0ms' : 'Connection successful'),
      ).toBeInTheDocument()
    },
  )

  it('records a zero-millisecond settings benchmark', async () => {
    setMaestroConfig({ llm_model: 'fast-model' })
    await renderReady('settings')

    fireEvent.click(screen.getByRole('button', { name: 'Test' }))

    await waitFor(() => expect(useAppStore.getState().llmTestStatus).toBe('success'))
    expect(useAppStore.getState().llmLatencyMs).toBe(0)
    expect(screen.getByText('0ms')).toBeInTheDocument()
  })

  it('treats a false onboarding result as a visible failure', async () => {
    setMaestroConfig({ llm_model: 'manual-model' })
    vi.mocked(tauri.testLlmConnection).mockResolvedValueOnce(false)
    await renderReady('onboarding')

    fireEvent.click(screen.getByRole('button', { name: 'Test' }))

    await waitFor(() => expect(useAppStore.getState().llmTestStatus).toBe('error'))
    expect(screen.getByText('Connection failed')).toBeInTheDocument()
  })

  it('shows discovered models without selecting one and accepts a manual model outside the list', async () => {
    vi.mocked(tauri.fetchLlmModels).mockResolvedValueOnce(['suggested-one', 'suggested-two'])
    await renderReady()

    fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }))
    await waitFor(() => expect(screen.getByText('2 models available')).toBeInTheDocument())
    expect(screen.getByLabelText('Model')).toHaveValue('')

    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'manual-only' } })
    expect(screen.getByLabelText('Model')).toHaveValue('manual-only')
    expect(useAppStore.getState().config.llm_model).toBe('manual-only')
  })

  it('renders loading, empty-success, and failure discovery states distinctly', async () => {
    const models = deferred<string[]>()
    vi.mocked(tauri.fetchLlmModels).mockReturnValueOnce(models.promise)
    await renderReady()

    fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }))
    expect(screen.getByText('Loading models…')).toBeInTheDocument()
    await act(async () => {
      models.resolve([])
      await models.promise
    })
    expect(screen.getByText('No models were returned.')).toBeInTheDocument()

    vi.mocked(tauri.fetchLlmModels).mockRejectedValueOnce(new Error('HTTP 503 unavailable'))
    fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }))
    await waitFor(() => expect(screen.getByText(/HTTP 503 unavailable/)).toBeInTheDocument())
    expect(screen.queryByText('No models were returned.')).not.toBeInTheDocument()
  })

  it('blocks discovery and testing when the credential read fails, and offers retry', async () => {
    setMaestroConfig({ llm_model: 'manual-model' })
    vi.mocked(tauri.readCredential)
      .mockRejectedValueOnce(new Error('vault unavailable with secret'))
      .mockResolvedValueOnce(null)
    await render(<AgentMaestroFields mode="settings" />)

    await waitFor(() =>
      expect(screen.getByText('Credential storage is unavailable.')).toBeInTheDocument(),
    )
    expect(screen.getByRole('button', { name: 'Test' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Fetch models' })).toBeDisabled()
    expect(screen.queryByText(/vault unavailable|secret/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByLabelText(/API Key/)).toBeEnabled())
  })

  it('blocks testing while the credential is loading or saving', async () => {
    setMaestroConfig({ llm_model: 'manual-model' })
    const read = deferred<string | null>()
    vi.mocked(tauri.readCredential).mockReturnValueOnce(read.promise)
    render(<AgentMaestroFields mode="settings" />)

    expect(screen.getByRole('button', { name: 'Test' })).toBeDisabled()
    expect(screen.getByText('Credential is still loading or saving.')).toBeInTheDocument()
    await act(async () => {
      read.resolve(null)
      await read.promise
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Test' })).toBeEnabled())

    const save = deferred<void>()
    vi.mocked(tauri.setCredential).mockReturnValueOnce(save.promise)
    fireEvent.change(screen.getByLabelText(/API Key/), { target: { value: 'optional-key' } })
    expect(screen.getByRole('button', { name: 'Test' })).toBeDisabled()
    expect(screen.getByText('Credential is still loading or saving.')).toBeInTheDocument()
    fireEvent.blur(screen.getByLabelText(/API Key/))
    await act(async () => {
      save.resolve()
      await save.promise
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Test' })).toBeEnabled())
  })

  it('keeps a cleared key editable after a save failure and retries it', async () => {
    vi.mocked(tauri.readCredential).mockResolvedValueOnce('stored-key')
    vi.mocked(tauri.setCredential)
      .mockRejectedValueOnce(new Error('vault write failed'))
      .mockResolvedValueOnce(undefined)
    await renderReady()

    const keyInput = screen.getByLabelText(/API Key/)
    fireEvent.change(keyInput, { target: { value: '' } })
    fireEvent.blur(keyInput)
    await waitFor(() =>
      expect(screen.getByText('Credential storage is unavailable.')).toBeInTheDocument(),
    )

    expect(keyInput).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() =>
      expect(screen.queryByText('Credential storage is unavailable.')).not.toBeInTheDocument(),
    )
    expect(tauri.setCredential).toHaveBeenLastCalledWith('llm', 'agent-maestro', '')
  })

  it('migrates a matching legacy key but does not clear another provider after a switch', async () => {
    setMaestroConfig({ llm_api_key: 'legacy-key' })
    const save = deferred<void>()
    vi.mocked(tauri.setCredential).mockReturnValueOnce(save.promise)
    render(<AgentMaestroFields mode="settings" />)
    await waitFor(() =>
      expect(tauri.setCredential).toHaveBeenCalledWith('llm', 'agent-maestro', 'legacy-key'),
    )

    act(() => {
      useAppStore.getState().updateConfig({
        llm_provider: 'openai',
        llm_api_key: 'openai-key',
      })
    })
    await act(async () => {
      save.resolve()
      await save.promise
    })

    expect(useAppStore.getState().config.llm_provider).toBe('openai')
    expect(useAppStore.getState().config.llm_api_key).toBe('openai-key')
  })

  it('does not migrate another provider key when the initial vault read resolves after a switch', async () => {
    const read = deferred<string | null>()
    vi.mocked(tauri.readCredential).mockReturnValueOnce(read.promise)
    render(<AgentMaestroFields mode="settings" />)

    act(() => {
      useAppStore.getState().updateConfig({
        llm_provider: 'openai',
        llm_api_key: 'openai-key',
      })
    })
    await act(async () => {
      read.resolve(null)
      await read.promise
    })

    expect(tauri.setCredential).not.toHaveBeenCalled()
  })

  it('clears a matching legacy inline key after successful migration', async () => {
    setMaestroConfig({ llm_api_key: 'legacy-key' })
    await renderReady()

    await waitFor(() => expect(useAppStore.getState().config.llm_api_key).toBe(''))
    expect(tauri.setCredential).toHaveBeenCalledWith('llm', 'agent-maestro', 'legacy-key')
  })

  it('redacts and bounds connection errors without logging caught objects', async () => {
    const key = 'known-secret'
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(tauri.readCredential).mockResolvedValueOnce(key)
    vi.mocked(tauri.benchLlmConnection).mockRejectedValueOnce(
      new Error(`HTTP failure ${key} ${'x'.repeat(400)}`),
    )
    setMaestroConfig({ llm_model: 'manual-model' })
    await renderReady()

    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(useAppStore.getState().llmTestStatus).toBe('error'))

    const feedback = screen.getByTestId('agent-maestro-test-error')
    expect(feedback.textContent).toContain('[REDACTED]')
    expect(feedback.textContent).not.toContain(key)
    expect(feedback.textContent!.length).toBeLessThanOrEqual(330)
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('invalidates success when configuration changes and ignores stale probes', async () => {
    const probe = deferred<number>()
    vi.mocked(tauri.benchLlmConnection).mockReturnValueOnce(probe.promise)
    setMaestroConfig({ llm_model: 'first-model' })
    const { unmount } = await renderReady()
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    expect(useAppStore.getState().llmTestStatus).toBe('testing')

    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'second-model' } })
    expect(useAppStore.getState().llmTestStatus).toBe('idle')
    expect(useAppStore.getState().llmLatencyMs).toBeNull()
    await act(async () => {
      probe.resolve(25)
      await probe.promise
    })
    expect(useAppStore.getState().llmTestStatus).toBe('idle')
    expect(useAppStore.getState().llmLatencyMs).toBeNull()

    const afterUnmount = deferred<number>()
    vi.mocked(tauri.benchLlmConnection).mockReturnValueOnce(afterUnmount.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    unmount()
    act(() => useAppStore.getState().updateConfig({ llm_provider: 'openai' }))
    await act(async () => {
      afterUnmount.resolve(30)
      await afterUnmount.promise
    })
    expect(useAppStore.getState().config.llm_provider).toBe('openai')
    expect(useAppStore.getState().llmTestStatus).not.toBe('success')
    expect(useAppStore.getState().llmLatencyMs).toBeNull()
  })
})
