import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SttSetupStep } from '../SttSetupStep'
import * as tauri from '../../../lib/tauri'

const mockStore = {
  config: {
    stt_provider: 'deepgram',
    stt_api_key: '',
    stt_custom_api_key: '',
    stt_custom_base_url: 'http://localhost:8000/v1',
    stt_custom_model: 'Systran/faster-whisper-large-v3',
    stt_azure_endpoint: '',
    stt_azure_deployment: '',
    stt_azure_api_version: '2024-10-21',
  },
  updateConfig: vi.fn(),
  sttTestStatus: 'idle',
  setSttTestStatus: vi.fn(),
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'onboarding.stt.serviceLabel': 'Service',
        'onboarding.stt.apiKeyLabel': 'API key',
        'onboarding.stt.apiKeyPlaceholder': 'API key',
        'onboarding.stt.testButton': 'Test',
        'onboarding.stt.connectionOk': 'OK',
        'onboarding.stt.connectionFail': 'Failed',
        'onboarding.stt.customWhisperConfigured': 'Custom Whisper',
        'providers.stt.deepgram': 'Deepgram',
        'providers.stt.customWhisper': 'Custom Whisper',
      })[key] ?? key,
  }),
}))

vi.mock('../../../stores/appStore', () => ({
  useAppStore: (selector: any) => selector(mockStore),
}))

vi.mock('../../../lib/tauri', () => ({
  testSttConnection: vi.fn().mockResolvedValue(true),
  readCredential: vi.fn().mockResolvedValue(null),
  setCredential: vi.fn().mockResolvedValue(undefined),
}))

beforeEach(() => {
  mockStore.config = {
    stt_provider: 'deepgram',
    stt_api_key: '',
    stt_custom_api_key: '',
    stt_custom_base_url: 'http://localhost:8000/v1',
    stt_custom_model: 'Systran/faster-whisper-large-v3',
    stt_azure_endpoint: '',
    stt_azure_deployment: '',
    stt_azure_api_version: '2024-10-21',
  }
  mockStore.updateConfig = vi.fn()
  mockStore.sttTestStatus = 'idle'
  mockStore.setSttTestStatus = vi.fn()
  vi.clearAllMocks()
  vi.mocked(tauri.testSttConnection).mockResolvedValue(true)
  vi.mocked(tauri.readCredential).mockResolvedValue(null)
  vi.mocked(tauri.setCredential).mockResolvedValue(undefined)
})

afterEach(() => cleanup())

describe('SttSetupStep', () => {
  it('does not clear a stored Azure credential when blurring the untouched loading field', async () => {
    let resolveRead!: (key: string) => void
    mockStore.config.stt_provider = 'azure-openai'
    vi.mocked(tauri.readCredential).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve
        }),
    )
    render(<SttSetupStep />)
    await waitFor(() => expect(tauri.readCredential).toHaveBeenCalled())
    fireEvent.blur(screen.getByPlaceholderText('API key'))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      resolveRead('stored-speech-key')
    })
    expect(screen.getByPlaceholderText('API key')).toHaveValue('stored-speech-key')
    expect(tauri.setCredential).not.toHaveBeenCalled()
  })

  it.each(['azure-openai', 'deepgram'])(
    'resets an interrupted %s onboarding test',
    async (provider) => {
      let resolveTest!: (ok: boolean) => void
      mockStore.config = {
        ...mockStore.config,
        stt_provider: provider,
        stt_api_key: 'deepgram-key',
        stt_azure_endpoint: 'https://speech.openai.azure.com',
        stt_azure_deployment: 'speech',
      }
      vi.mocked(tauri.readCredential).mockResolvedValue('speech-key')
      vi.mocked(tauri.testSttConnection).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveTest = resolve
          }),
      )
      const { unmount } = render(<SttSetupStep />)
      await waitFor(() => expect(screen.getByRole('button', { name: 'Test' })).not.toBeDisabled())
      fireEvent.click(screen.getByRole('button', { name: 'Test' }))
      await waitFor(() => expect(tauri.testSttConnection).toHaveBeenCalled())
      mockStore.setSttTestStatus.mockClear()
      unmount()
      expect(mockStore.setSttTestStatus).toHaveBeenCalledWith('idle')
      resolveTest(true)
      await Promise.resolve()
      expect(mockStore.setSttTestStatus).not.toHaveBeenCalledWith('success')
    },
  )

  it.each(['endpoint', 'deployment', 'version', 'key'])(
    'disables Azure testing when %s is missing',
    async (missing) => {
      mockStore.config = {
        ...mockStore.config,
        stt_provider: 'azure-openai',
        stt_azure_endpoint: missing === 'endpoint' ? ' ' : 'https://speech.openai.azure.com',
        stt_azure_deployment: missing === 'deployment' ? ' ' : 'speech',
        stt_azure_api_version: missing === 'version' ? ' ' : '2024-10-21',
      }
      const key = missing === 'key' ? ' ' : 'speech-key'
      vi.mocked(tauri.readCredential).mockResolvedValue(key)
      render(<SttSetupStep />)
      await waitFor(() => expect(screen.getByPlaceholderText('API key')).toHaveValue(key))
      expect(screen.getByRole('button', { name: 'Test' })).toBeDisabled()
    },
  )

  it('offers Azure with dedicated fields and disables incomplete setup', async () => {
    const { rerender } = render(<SttSetupStep />)
    expect(screen.getByRole('option', { name: 'providers.stt.azureOpenAi' })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'azure-openai' } })
    expect(mockStore.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ stt_provider: 'azure-openai', stt_api_key: '' }),
    )
    mockStore.config = {
      ...mockStore.config,
      stt_provider: 'azure-openai',
      stt_api_key: 'old-secret',
    }
    rerender(<SttSetupStep />)
    await waitFor(() => expect(screen.getByPlaceholderText('API key')).toHaveValue(''))
    expect(screen.getByLabelText('azure.resourceEndpoint')).toHaveValue('')
    expect(screen.getByLabelText('azure.deploymentName')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Test' })).toBeDisabled()
    expect(screen.getByText('azure.bufferedSttHint')).toBeInTheDocument()
  })

  it('tests Azure options and stores its key separately from legacy and Custom Whisper keys', async () => {
    mockStore.config = {
      ...mockStore.config,
      stt_provider: 'azure-openai',
      stt_azure_endpoint: 'https://speech.openai.azure.com',
      stt_azure_deployment: 'speech',
      stt_azure_api_version: '2025-04-01-preview',
    }
    vi.mocked(tauri.readCredential).mockResolvedValue('speech-key')
    render(<SttSetupStep />)
    await waitFor(() => expect(screen.getByPlaceholderText('API key')).toHaveValue('speech-key'))
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    await waitFor(() =>
      expect(tauri.testSttConnection).toHaveBeenCalledWith(
        'speech-key',
        'azure-openai',
        undefined,
        undefined,
        undefined,
        undefined,
        {
          endpoint: 'https://speech.openai.azure.com',
          deployment: 'speech',
          apiVersion: '2025-04-01-preview',
        },
      ),
    )
    fireEvent.change(screen.getByPlaceholderText('API key'), {
      target: { value: 'new-speech-key' },
    })
    fireEvent.blur(screen.getByPlaceholderText('API key'))
    await waitFor(() =>
      expect(tauri.setCredential).toHaveBeenCalledWith('stt', 'azure-openai', 'new-speech-key'),
    )
    expect(mockStore.updateConfig).not.toHaveBeenCalledWith({ stt_api_key: 'new-speech-key' })
    expect(mockStore.config.stt_custom_model).toBe('Systran/faster-whisper-large-v3')
  })

  it('shows the actual Azure connection error', async () => {
    mockStore.config = {
      ...mockStore.config,
      stt_provider: 'azure-openai',
      stt_azure_endpoint: 'https://speech.openai.azure.com',
      stt_azure_deployment: 'speech',
    }
    vi.mocked(tauri.readCredential).mockResolvedValue('speech-key')
    vi.mocked(tauri.testSttConnection).mockRejectedValue(new Error('Unsupported deployment'))
    render(<SttSetupStep />)
    await waitFor(() => expect(screen.getByPlaceholderText('API key')).toHaveValue('speech-key'))
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(screen.getByText('Unsupported deployment')).toBeInTheDocument())
  })

  it('invalidates a saved Azure test result when loading a missing credential', async () => {
    mockStore.config = {
      ...mockStore.config,
      stt_provider: 'azure-openai',
      stt_azure_endpoint: 'https://speech.openai.azure.com',
      stt_azure_deployment: 'speech',
    }
    mockStore.sttTestStatus = 'success'
    render(<SttSetupStep />)
    await waitFor(() => expect(mockStore.setSttTestStatus).toHaveBeenCalledWith('idle'))
    expect(screen.getByRole('button', { name: 'Test' })).toBeDisabled()
  })

  it('does not offer managed Cloud inside BYOK provider setup', () => {
    render(<SttSetupStep />)

    const providerSelect = screen.getByRole('combobox')
    expect(providerSelect.querySelector('option[value="cloud"]')).toBeNull()
  })

  it('preserves an existing Custom Whisper setup instead of switching providers', () => {
    mockStore.config = {
      ...mockStore.config,
      stt_provider: 'custom-whisper',
      stt_custom_base_url: 'http://localhost:9000/v1',
      stt_custom_model: 'local-large-v3',
    }

    render(<SttSetupStep />)

    expect(screen.getByText('Custom Whisper')).toBeInTheDocument()
    expect(screen.getByText('http://localhost:9000/v1')).toBeInTheDocument()
    expect(screen.getByText('local-large-v3')).toBeInTheDocument()
    expect(mockStore.updateConfig).not.toHaveBeenCalledWith({ stt_provider: 'deepgram' })
  })

  it('tests Custom Whisper with its configured endpoint and model', async () => {
    const tauri = await import('../../../lib/tauri')
    mockStore.config = {
      ...mockStore.config,
      stt_provider: 'custom-whisper',
      stt_custom_api_key: 'custom-secret',
      stt_custom_base_url: 'http://localhost:9000/v1',
      stt_custom_model: 'local-large-v3',
    }

    render(<SttSetupStep />)
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))

    await waitFor(() => {
      expect(tauri.testSttConnection).toHaveBeenCalledWith(
        'custom-secret',
        'custom-whisper',
        'http://localhost:9000/v1',
        'local-large-v3',
      )
    })
  })
})
