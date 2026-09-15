import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { LlmPane } from '../LlmPane'
import * as tauri from '../../../lib/tauri'

// Mock Tauri
vi.mock('../../../lib/tauri')

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

vi.mock('../../AgentMaestroFields', () => ({
  AgentMaestroFields: ({ mode }: { mode: string }) => (
    <div data-testid={`agent-maestro-${mode}`}>
      <input aria-label="Agent Maestro model" />
      <button type="button">Agent Maestro test</button>
    </div>
  ),
}))

// Mock i18n
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: any) => {
      const translations: Record<string, string> = {
        'settings.provider': 'Provider',
        'nav.upgrade': 'Upgrade',
        'settings.apiKey': 'API Key',
        'settings.model': 'Model',
        'settings.baseUrl': 'Base URL',
        'settings.test': 'Test',
        'settings.enterApiKey': 'Enter API Key',
        'settings.connectionSuccess': 'Connection successful',
        'settings.connectionFailed': 'Connection failed',
        'settings.storedLocally': 'Stored locally',
        'settings.fetchModels': 'Fetch models',
        'settings.modelsAvailable': `${params?.count || 0} models available`,
        'settings.modelCertified': 'Optimized context and thought-aware support',
        'settings.modelBestEffort': 'Context and thought-aware support is best effort',
        'settings.llmModelPlaceholder': 'e.g. gpt-4o-mini',
        'settings.enableAiPolish': 'AI cleanup for dictation',
        'settings.enableAiPolishDesc': 'Cleans up dictation before output',
        'settings.contextAdaptation': 'Adapt writing to the current app',
        'settings.contextAdaptationHint': 'Uses a private local app category',
        'settings.contextAdaptationApps': 'Apps adapted by context',
        'settings.lastDictationContext': 'Last dictation context',
        'settings.browserAccessHint':
          'Allow browser access to use Gmail, Docs, and Slack Web modes.',
        'settings.appStyleMenu': 'App writing style',
        'settings.useDifferentWritingStyle': 'Use a different writing style',
        'settings.manageAppMappings': 'Manage app mappings',
        'settings.appStyleDialogTitle': 'Writing style for this app',
        'settings.polishStyle': 'Polish style',
        'settings.polishStyleMinimal': 'Minimal',
        'settings.polishStyleClean': 'Clean',
        'settings.polishStyleStructured': 'Structured',
        'settings.polishStyleProfessional': 'Professional',
        'settings.advancedPolishSettings': 'Advanced polish settings',
        'settings.advancedPolishSettingsDesc': 'Optional writing rules',
        'settings.customPolishInstructions': 'Custom polish instructions',
        'settings.customPolishInstructionsPlaceholder': 'Example prompt',
        'settings.customPolishInstructionsCount': `${params?.count || 0} / 2000 characters`,
        'settings.activeScene': `Active scene: ${params?.name || ''}`,
        'settings.clearActiveScene': 'Clear scene',
        'settings.translationMode': 'Always translate output',
        'settings.translationModeDesc': 'Translate each dictation result',
        'settings.selectedTextContext': 'Use selected text as context',
        'settings.selectedTextContextDesc': 'Use selected text for context',
        'settings.targetLanguage': 'Translate to',
        'settings.manageTranslationTargets': 'Manage languages',
        'settings.cloudLlmPro': 'Cloud LLM (Pro)',
        'settings.llmSignInHint':
          'Sign in and subscribe to Pro to use cloud AI polish. No API key needed.',
        'settings.llmUpgradeHint':
          'Upgrade to Pro for cloud AI polish and monthly usage. No API key needed.',
        'settings.llmProActive': 'Pro active — cloud AI polish is ready. No API key needed.',
        'settings.askAnything': 'Ask Anything',
        'settings.askAnythingDesc': 'Voice question, one-shot answer. No chat history.',
        'ask.ready': 'Ready to ask',
        'ask.listening': 'Listening',
        'ask.thinking': 'Thinking',
        'ask.voiceQuestion': 'Voice question',
        'ask.voiceQuestionDesc': 'Speak your question. Stop recording to answer.',
        'ask.transcriptLabel': 'Question transcript',
        'ask.answerLabel': 'Answer',
        'ask.manualFallback': 'Type instead',
        'ask.placeholder': 'Type a question, or use the capsule above.',
        'ask.recordQuestion': 'Record question',
        'ask.stopAndAsk': 'Stop and ask',
        'ask.send': 'Ask',
        'providers.llm.doubao': 'Doubao (Volcengine)',
        'providers.llm.agentMaestro': 'Agent Maestro',
      }
      return translations[key] || key
    },
  }),
}))

// Mock stores - must be done before importing the component
const mockAppStore = {
  config: {
    llm_provider: 'openai' as string,
    llm_api_key: '',
    llm_base_url: 'https://api.openai.com/v1',
    llm_model: 'gpt-4o-mini',
    llm_azure_api_version: '2024-10-21',
    polish_enabled: true,
    context_adaptation_enabled: true,
    polish_style: 'clean',
    polish_custom_prompt: '',
    polish_chinese_script: 'preserve',
    custom_scenes: [],
    active_scene: null as any,
    family_scene_assignments: [],
    translate_enabled: false,
    selected_text_enabled: false,
    target_lang: 'en',
    translation: { targets: ['en'], active_target: 'en' },
  },
  updateConfig: vi.fn(),
  setConfig: vi.fn(),
  setSavedConfig: vi.fn(),
  llmTestStatus: 'idle' as 'idle' | 'testing' | 'success' | 'error',
  setLlmTestStatus: vi.fn(),
  llmLatencyMs: null as number | null,
  setLlmLatencyMs: vi.fn(),
  llmModels: [] as string[],
  setLlmModels: vi.fn(),
  lastContext: null as any,
}

const mockAuthStore = {
  user: null as any,
  plan: null as any,
  source: 'free',
  cloudWordsLimit: 0,
  licenseStatus: null as any,
}

vi.mock('../../../stores/appStore', () => ({
  useAppStore: (selector: any) => {
    if (typeof selector === 'function') {
      return selector(mockAppStore)
    }
    return mockAppStore
  },
}))

vi.mock('../../../stores/authStore', () => ({
  hasManagedCloudAccess: (state: typeof mockAuthStore) =>
    state.licenseStatus !== 'refunded' &&
    state.licenseStatus !== 'deactivated' &&
    ((state.source === 'creem' && state.cloudWordsLimit > 0) ||
      (state.source === 'appsumo' &&
        state.cloudWordsLimit > 0 &&
        state.licenseStatus === 'active') ||
      state.plan === 'pro'),
  useAuthStore: (selector: any) => {
    if (typeof selector === 'function') {
      return selector(mockAuthStore)
    }
    return mockAuthStore
  },
}))

describe('LlmPane', () => {
  beforeEach(() => {
    // Reset mock store state
    mockAppStore.config = {
      llm_provider: 'openai',
      llm_api_key: '',
      llm_base_url: 'https://api.openai.com/v1',
      llm_model: 'gpt-4o-mini',
      llm_azure_api_version: '2024-10-21',
      polish_enabled: true,
      context_adaptation_enabled: true,
      polish_style: 'clean',
      polish_custom_prompt: '',
      polish_chinese_script: 'preserve',
      custom_scenes: [],
      active_scene: null,
      family_scene_assignments: [],
      translate_enabled: false,
      selected_text_enabled: false,
      target_lang: 'en',
      translation: { targets: ['en'], active_target: 'en' },
    }
    mockAppStore.llmTestStatus = 'idle'
    mockAppStore.llmLatencyMs = null
    mockAppStore.llmModels = []
    mockAppStore.lastContext = null
    mockAuthStore.user = null
    mockAuthStore.plan = null
    mockAuthStore.source = 'free'
    mockAuthStore.cloudWordsLimit = 0
    mockAuthStore.licenseStatus = null

    vi.clearAllMocks()
    vi.mocked(tauri.readCredential).mockResolvedValue(null)
    vi.mocked(tauri.setCredential).mockResolvedValue(undefined)
    vi.mocked(tauri.getLlmModelCapability).mockResolvedValue('unknown')
    vi.mocked(tauri.getLatestMappingCandidate).mockResolvedValue(null)
    vi.mocked(tauri.listCustomAppMappings).mockResolvedValue([])
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  describe('Provider selection', () => {
    it('selects Azure with empty resource and deployment defaults', () => {
      render(<LlmPane />)
      expect(screen.getByRole('option', { name: 'providers.llm.azureOpenAi' })).toBeInTheDocument()
      fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'azure-openai' } })
      expect(mockAppStore.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          llm_provider: 'azure-openai',
          llm_base_url: '',
          llm_model: '',
        }),
      )
    })

    it.each(['endpoint', 'deployment', 'version', 'key'])(
      'disables Azure testing when %s is missing',
      async (missing) => {
        mockAppStore.config = {
          ...mockAppStore.config,
          llm_provider: 'azure-openai',
          llm_base_url: missing === 'endpoint' ? ' ' : 'https://chat.openai.azure.com',
          llm_model: missing === 'deployment' ? ' ' : 'chat',
          llm_azure_api_version: missing === 'version' ? ' ' : '2024-10-21',
        }
        const key = missing === 'key' ? ' ' : 'azure-key'
        vi.mocked(tauri.readCredential).mockResolvedValue(key)
        render(<LlmPane />)
        await waitFor(() => expect(screen.getByPlaceholderText('Enter API Key')).toHaveValue(key))
        expect(screen.getByRole('button', { name: 'Test' })).toBeDisabled()
      },
    )

    it('requires complete Azure options and forwards a custom version without model discovery', async () => {
      mockAppStore.config = {
        ...mockAppStore.config,
        llm_provider: 'azure-openai',
        llm_base_url: '',
        llm_model: '',
      }
      vi.mocked(tauri.readCredential).mockResolvedValue('azure-key')
      vi.mocked(tauri.benchLlmConnection).mockResolvedValue(42)
      const { rerender } = render(<LlmPane />)
      await waitFor(() =>
        expect(screen.getByPlaceholderText('Enter API Key')).toHaveValue('azure-key'),
      )
      expect(screen.getByRole('button', { name: 'Test' })).toBeDisabled()
      expect(screen.getByLabelText('azure.resourceEndpoint')).toHaveValue('')
      expect(screen.getByLabelText('azure.deploymentName')).toHaveValue('')
      expect(screen.queryByTitle('Fetch models')).not.toBeInTheDocument()
      mockAppStore.config = {
        ...mockAppStore.config,
        llm_base_url: 'https://chat.openai.azure.com',
        llm_model: 'chat',
        llm_azure_api_version: '2025-04-01-preview',
      }
      rerender(<LlmPane />)
      fireEvent.click(screen.getByRole('button', { name: 'Test' }))
      await waitFor(() =>
        expect(tauri.benchLlmConnection).toHaveBeenCalledWith(
          'azure-key',
          'azure-openai',
          'https://chat.openai.azure.com',
          'chat',
          '2025-04-01-preview',
        ),
      )
      await new Promise((resolve) => setTimeout(resolve, 550))
      expect(tauri.fetchLlmModels).not.toHaveBeenCalled()
      fireEvent.change(screen.getByLabelText('azure.apiVersion'), { target: { value: '' } })
      expect(mockAppStore.setLlmTestStatus).toHaveBeenCalledWith('idle')
    })

    it('isolates Azure credentials while persisting pending edits to the previous provider', async () => {
      mockAppStore.config.llm_api_key = 'old-legacy-key'
      const { rerender } = render(<LlmPane />)
      fireEvent.change(screen.getByPlaceholderText('Enter API Key'), {
        target: { value: 'old-draft' },
      })
      mockAppStore.config = { ...mockAppStore.config, llm_provider: 'azure-openai' }
      vi.mocked(tauri.readCredential).mockResolvedValue('azure-key')
      rerender(<LlmPane />)
      await waitFor(() =>
        expect(screen.getByPlaceholderText('Enter API Key')).toHaveValue('azure-key'),
      )
      await waitFor(() =>
        expect(tauri.setCredential).toHaveBeenCalledWith('llm', 'openai', 'old-draft'),
      )
      expect(tauri.setCredential).not.toHaveBeenCalledWith('llm', 'azure-openai', 'old-draft')
      fireEvent.change(screen.getByPlaceholderText('Enter API Key'), {
        target: { value: 'new-azure-key' },
      })
      fireEvent.blur(screen.getByPlaceholderText('Enter API Key'))
      await waitFor(() =>
        expect(tauri.setCredential).toHaveBeenCalledWith('llm', 'azure-openai', 'new-azure-key'),
      )
    })

    it('ignores a prior provider model fetch that completes after switching to Azure', async () => {
      let resolveModels!: (models: string[]) => void
      mockAppStore.config.llm_api_key = 'old-key'
      vi.mocked(tauri.fetchLlmModels).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveModels = resolve
          }),
      )
      const { rerender } = render(<LlmPane />)
      fireEvent.click(screen.getByTitle('Fetch models'))
      mockAppStore.config = { ...mockAppStore.config, llm_provider: 'azure-openai' }
      rerender(<LlmPane />)
      resolveModels(['not-a-deployment'])
      await waitFor(() => expect(screen.queryByTitle('Fetch models')).not.toBeInTheDocument())
      expect(mockAppStore.setLlmModels).not.toHaveBeenCalledWith(['not-a-deployment'])
    })

    it('shows actual Azure credential read failures', async () => {
      mockAppStore.config.llm_provider = 'azure-openai'
      vi.mocked(tauri.readCredential).mockRejectedValue(new Error('vault locked'))
      render(<LlmPane />)
      await waitFor(() => expect(screen.getByText(/vault locked/)).toBeInTheDocument())
      expect(screen.queryByText('Stored locally')).not.toBeInTheDocument()
    })

    it('does not carry a failed prior-provider save into an Azure connection test', async () => {
      vi.mocked(tauri.setCredential).mockRejectedValueOnce(new Error('old vault failure'))
      const { rerender } = render(<LlmPane />)
      fireEvent.change(screen.getByPlaceholderText('Enter API Key'), {
        target: { value: 'old-key' },
      })
      fireEvent.blur(screen.getByPlaceholderText('Enter API Key'))
      await screen.findByText('old vault failure')
      mockAppStore.config = {
        ...mockAppStore.config,
        llm_provider: 'azure-openai',
        llm_base_url: 'https://chat.openai.azure.com',
        llm_model: 'chat',
      }
      vi.mocked(tauri.readCredential).mockResolvedValue('azure-key')
      vi.mocked(tauri.benchLlmConnection).mockResolvedValue(42)
      rerender(<LlmPane />)
      await waitFor(() =>
        expect(screen.getByPlaceholderText('Enter API Key')).toHaveValue('azure-key'),
      )
      fireEvent.click(screen.getByRole('button', { name: 'Test' }))
      await waitFor(() =>
        expect(tauri.benchLlmConnection).toHaveBeenCalledWith(
          'azure-key',
          'azure-openai',
          'https://chat.openai.azure.com',
          'chat',
          '2024-10-21',
        ),
      )
    })

    it('does not replace a new Azure key draft with a late credential read', async () => {
      let resolveKey!: (key: string) => void
      mockAppStore.config.llm_provider = 'azure-openai'
      vi.mocked(tauri.readCredential).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveKey = resolve
          }),
      )
      render(<LlmPane />)
      await waitFor(() => expect(tauri.readCredential).toHaveBeenCalled())
      fireEvent.change(screen.getByPlaceholderText('Enter API Key'), {
        target: { value: 'typed-key' },
      })
      resolveKey('stored-key')
      await waitFor(() =>
        expect(screen.getByPlaceholderText('Enter API Key')).toHaveValue('typed-key'),
      )
    })

    it('resets an interrupted connection test when leaving the pane', async () => {
      let resolveTest!: (latency: number) => void
      mockAppStore.config.llm_provider = 'azure-openai'
      vi.mocked(tauri.readCredential).mockResolvedValue('azure-key')
      vi.mocked(tauri.benchLlmConnection).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveTest = resolve
          }),
      )
      const { unmount } = render(<LlmPane />)
      await waitFor(() =>
        expect(screen.getByPlaceholderText('Enter API Key')).toHaveValue('azure-key'),
      )
      fireEvent.click(screen.getByRole('button', { name: 'Test' }))
      await waitFor(() => expect(tauri.benchLlmConnection).toHaveBeenCalled())
      mockAppStore.setLlmTestStatus.mockClear()
      unmount()
      expect(mockAppStore.setLlmTestStatus).toHaveBeenCalledWith('idle')
      resolveTest(42)
      await Promise.resolve()
      expect(mockAppStore.setLlmTestStatus).not.toHaveBeenCalledWith('success')
    })

    it('orders queued Azure saves before newer keys entered after switching back', async () => {
      let resolveFirstSave!: () => void
      mockAppStore.config.llm_provider = 'azure-openai'
      vi.mocked(tauri.setCredential).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstSave = resolve
          }),
      )
      const { rerender } = render(<LlmPane />)
      fireEvent.change(screen.getByPlaceholderText('Enter API Key'), {
        target: { value: 'first-key' },
      })
      fireEvent.blur(screen.getByPlaceholderText('Enter API Key'))
      await waitFor(() =>
        expect(tauri.setCredential).toHaveBeenCalledWith('llm', 'azure-openai', 'first-key'),
      )
      fireEvent.change(screen.getByPlaceholderText('Enter API Key'), {
        target: { value: 'obsolete-queued-key' },
      })
      fireEvent.blur(screen.getByPlaceholderText('Enter API Key'))
      await new Promise((resolve) => setTimeout(resolve, 10))
      mockAppStore.config.llm_provider = 'openai'
      rerender(<LlmPane />)
      mockAppStore.config.llm_provider = 'azure-openai'
      rerender(<LlmPane />)
      fireEvent.change(screen.getByPlaceholderText('Enter API Key'), {
        target: { value: 'latest-key' },
      })
      fireEvent.blur(screen.getByPlaceholderText('Enter API Key'))
      resolveFirstSave()
      await waitFor(() =>
        expect(tauri.setCredential).toHaveBeenCalledWith('llm', 'azure-openai', 'latest-key'),
      )
      expect(vi.mocked(tauri.setCredential).mock.calls.map((call) => call[2])).toEqual([
        'first-key',
        'obsolete-queued-key',
        'latest-key',
      ])
      expect(vi.mocked(tauri.setCredential).mock.calls.slice(-1)[0]).toEqual([
        'llm',
        'azure-openai',
        'latest-key',
      ])
    })

    it('renders provider dropdown with current value', () => {
      render(<LlmPane />)
      const selects = screen.getAllByRole('combobox')
      const providerSelect = selects[0] // First select is provider
      expect(providerSelect).toHaveValue('openai')
    })

    it('updates config and resets state when provider changes', () => {
      render(<LlmPane />)
      const selects = screen.getAllByRole('combobox')
      const providerSelect = selects[0]

      fireEvent.change(providerSelect, { target: { value: 'anthropic' } })

      expect(mockAppStore.updateConfig).toHaveBeenCalled()
      expect(mockAppStore.setLlmTestStatus).toHaveBeenCalledWith('idle')
      expect(mockAppStore.setLlmLatencyMs).toHaveBeenCalledWith(null)
      expect(mockAppStore.setLlmModels).toHaveBeenCalledWith([])
    })

    it('applies Doubao defaults when provider changes to Doubao', () => {
      render(<LlmPane />)
      const selects = screen.getAllByRole('combobox')
      const providerSelect = selects[0]

      fireEvent.change(providerSelect, { target: { value: 'doubao' } })

      expect(mockAppStore.updateConfig).toHaveBeenCalledWith({
        llm_provider: 'doubao',
        llm_base_url: 'https://ark.cn-beijing.volces.com/api/v3',
        llm_model: 'doubao-seed-1-6-flash-250615',
      })
      expect(mockAppStore.setLlmTestStatus).toHaveBeenCalledWith('idle')
      expect(mockAppStore.setLlmLatencyMs).toHaveBeenCalledWith(null)
      expect(mockAppStore.setLlmModels).toHaveBeenCalledWith([])
    })

    it('applies isolated Agent Maestro defaults without inheriting the previous key', () => {
      mockAppStore.config.llm_api_key = 'old-provider-secret'
      render(<LlmPane />)

      fireEvent.change(screen.getAllByRole('combobox')[0], {
        target: { value: 'agent-maestro' },
      })

      expect(mockAppStore.updateConfig).toHaveBeenCalledWith({
        llm_provider: 'agent-maestro',
        llm_api_key: '',
        llm_base_url: 'http://127.0.0.1:23333/api/openai/v1',
        llm_model: '',
      })
    })

    it('renders only the shared Agent Maestro form instead of legacy provider fields', () => {
      mockAppStore.config = {
        ...mockAppStore.config,
        llm_provider: 'agent-maestro',
        llm_api_key: '',
        llm_base_url: 'http://127.0.0.1:23333/api/openai/v1',
        llm_model: '',
      }

      render(<LlmPane />)

      expect(screen.getByTestId('agent-maestro-settings')).toBeInTheDocument()
      expect(screen.getAllByRole('textbox', { name: 'Agent Maestro model' })).toHaveLength(1)
      expect(screen.getAllByRole('button', { name: 'Agent Maestro test' })).toHaveLength(1)
      expect(screen.queryByPlaceholderText('Enter API Key')).not.toBeInTheDocument()
      expect(screen.queryByTitle('Fetch models')).not.toBeInTheDocument()
      expect(tauri.readCredential).not.toHaveBeenCalled()
      expect(tauri.fetchLlmModels).not.toHaveBeenCalled()
    })

    it('ignores legacy model discovery that completes after switching to Agent Maestro', async () => {
      const pendingModels = deferred<string[]>()
      mockAppStore.config.llm_api_key = 'old-provider-secret'
      vi.mocked(tauri.fetchLlmModels).mockReturnValueOnce(pendingModels.promise)
      render(<LlmPane />)

      fireEvent.click(screen.getByTitle('Fetch models'))
      fireEvent.change(screen.getAllByRole('combobox')[0], {
        target: { value: 'agent-maestro' },
      })
      await act(async () => pendingModels.resolve(['stale-openai-model']))

      expect(mockAppStore.setLlmModels).not.toHaveBeenCalledWith(['stale-openai-model'])
    })

    it('ignores a legacy connection probe that completes after switching to Agent Maestro', async () => {
      const pendingProbe = deferred<number>()
      mockAppStore.config.llm_api_key = 'old-provider-secret'
      vi.mocked(tauri.benchLlmConnection).mockReturnValueOnce(pendingProbe.promise)
      render(<LlmPane />)

      fireEvent.click(screen.getByRole('button', { name: 'Test' }))
      fireEvent.change(screen.getAllByRole('combobox')[0], {
        target: { value: 'agent-maestro' },
      })
      await act(async () => pendingProbe.resolve(12))

      expect(mockAppStore.setLlmTestStatus).not.toHaveBeenCalledWith('success')
    })
  })

  describe('Cloud provider UI', () => {
    it('keeps Ask Anything out of AI Polish settings', () => {
      render(<LlmPane />)

      expect(screen.queryByText('Ask Anything')).not.toBeInTheDocument()
      expect(screen.queryByText('Voice question')).not.toBeInTheDocument()
    })

    it('shows cloud info when provider is cloud and user not signed in', () => {
      mockAppStore.config.llm_provider = 'cloud'
      render(<LlmPane />)
      expect(screen.getByText('Cloud LLM (Pro)')).toBeInTheDocument()
      expect(
        screen.getByText('Sign in and subscribe to Pro to use cloud AI polish. No API key needed.'),
      ).toBeInTheDocument()
    })

    it('shows upgrade hint when user is signed in but not pro', () => {
      mockAppStore.config.llm_provider = 'cloud'
      mockAuthStore.user = { id: '1', email: 'test@example.com' }
      mockAuthStore.plan = 'free'

      render(<LlmPane />)
      expect(screen.getByText('Cloud LLM (Pro)')).toBeInTheDocument()
      expect(
        screen.getByText(
          'Upgrade to Pro for cloud AI polish and monthly usage. No API key needed.',
        ),
      ).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Upgrade' }))
      expect(window.location.hash).toBe('#/upgrade')
    })

    it('shows active status when user is pro', () => {
      mockAppStore.config.llm_provider = 'cloud'
      mockAuthStore.user = { id: '1', email: 'test@example.com' }
      mockAuthStore.plan = 'pro'

      render(<LlmPane />)
      expect(
        screen.getByText('Pro active — cloud AI polish is ready. No API key needed.'),
      ).toBeInTheDocument()
    })
  })

  describe('API Key input', () => {
    it('renders API key input with current value', () => {
      mockAppStore.config.llm_api_key = 'sk-test123'
      render(<LlmPane />)
      const input = screen.getByPlaceholderText('Enter API Key') as HTMLInputElement
      expect(input.value).toBe('sk-test123')
      expect(input.type).toBe('password')
    })

    it('stores API key in credential vault and resets test state when API key changes', async () => {
      render(<LlmPane />)
      const input = screen.getByPlaceholderText('Enter API Key')

      fireEvent.change(input, { target: { value: 'sk-new-key' } })
      fireEvent.blur(input)

      await waitFor(() =>
        expect(tauri.setCredential).toHaveBeenCalledWith('llm', 'openai', 'sk-new-key'),
      )
      expect(mockAppStore.updateConfig).not.toHaveBeenCalledWith({ llm_api_key: 'sk-new-key' })
      expect(mockAppStore.setLlmTestStatus).toHaveBeenCalledWith('idle')
      expect(mockAppStore.setLlmLatencyMs).toHaveBeenCalledWith(null)
    })

    it('shows an inline error when credential vault save fails', async () => {
      vi.mocked(tauri.setCredential).mockRejectedValueOnce(new Error('vault unavailable'))
      render(<LlmPane />)
      const input = screen.getByPlaceholderText('Enter API Key')

      fireEvent.change(input, { target: { value: 'sk-new-key' } })
      fireEvent.blur(input)

      expect(await screen.findByText('vault unavailable')).toBeInTheDocument()
    })
  })

  describe('Test button and latency display', () => {
    it('test button is disabled when API key is empty', () => {
      render(<LlmPane />)
      const button = screen.getByRole('button', { name: /test/i })
      expect(button).toBeDisabled()
    })

    it('test button is enabled when API key is present', () => {
      mockAppStore.config.llm_api_key = 'sk-test123'
      render(<LlmPane />)
      const button = screen.getByRole('button', { name: /test/i })
      expect(button).not.toBeDisabled()
    })

    it('allows testing Ollama without an API key', async () => {
      vi.mocked(tauri.benchLlmConnection).mockResolvedValue(42)
      mockAppStore.config.llm_provider = 'ollama'
      mockAppStore.config.llm_api_key = ''
      mockAppStore.config.llm_base_url = 'http://localhost:11434/v1'
      mockAppStore.config.llm_model = 'llama3.2'

      render(<LlmPane />)
      const button = screen.getByRole('button', { name: /test/i })

      expect(screen.queryByPlaceholderText('Enter API Key')).not.toBeInTheDocument()
      expect(button).not.toBeDisabled()
      fireEvent.click(button)
      await waitFor(() =>
        expect(tauri.benchLlmConnection).toHaveBeenCalledWith(
          '',
          'ollama',
          'http://localhost:11434/v1',
          'llama3.2',
        ),
      )
    })

    it('auto-fetches Ollama models without an API key', async () => {
      vi.useFakeTimers()
      try {
        mockAppStore.config.llm_provider = 'ollama'
        mockAppStore.config.llm_api_key = ''
        mockAppStore.config.llm_base_url = 'http://localhost:11434/v1'

        render(<LlmPane />)
        await vi.advanceTimersByTimeAsync(500)

        expect(tauri.fetchLlmModels).toHaveBeenCalledWith('', 'ollama', 'http://localhost:11434/v1')
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not fetch keyed-provider models before an API key is entered', () => {
      render(<LlmPane />)

      expect(screen.getByTitle('Fetch models')).toBeDisabled()
    })

    it('shows loading state during test', () => {
      mockAppStore.config.llm_api_key = 'sk-test123'
      mockAppStore.llmTestStatus = 'testing'
      render(<LlmPane />)
      const button = screen.getByRole('button', { name: /test/i })
      expect(button).toBeDisabled()
    })

    it('calls benchLlmConnection on test button click', async () => {
      const mockBenchLlm = vi.mocked(tauri.benchLlmConnection)
      mockBenchLlm.mockResolvedValue(187)

      mockAppStore.config.llm_api_key = 'sk-test123'
      render(<LlmPane />)
      const button = screen.getByRole('button', { name: /test/i })

      fireEvent.click(button)

      await waitFor(() => {
        expect(mockAppStore.setLlmTestStatus).toHaveBeenCalledWith('testing')
        expect(mockAppStore.setLlmLatencyMs).toHaveBeenCalledWith(null)
      })

      await waitFor(() => {
        expect(mockBenchLlm).toHaveBeenCalledWith(
          'sk-test123',
          'openai',
          'https://api.openai.com/v1',
          'gpt-4o-mini',
        )
      })
    })

    it('displays latency in milliseconds when test succeeds', () => {
      mockAppStore.config.llm_api_key = 'sk-test123'
      mockAppStore.llmTestStatus = 'success'
      mockAppStore.llmLatencyMs = 187

      render(<LlmPane />)
      expect(screen.getByText('187ms')).toBeInTheDocument()
    })

    it('displays generic success message when latency is null', () => {
      mockAppStore.config.llm_api_key = 'sk-test123'
      mockAppStore.llmTestStatus = 'success'
      mockAppStore.llmLatencyMs = null

      render(<LlmPane />)
      expect(screen.getByText('Connection successful')).toBeInTheDocument()
    })

    it('shows error state UI', () => {
      mockAppStore.config.llm_api_key = 'sk-test123'
      mockAppStore.llmTestStatus = 'error'

      render(<LlmPane />)
      expect(screen.getByText('Connection failed')).toBeInTheDocument()
    })

    it('shows backend error details when test fails', async () => {
      const mockBenchLlm = vi.mocked(tauri.benchLlmConnection)
      mockBenchLlm.mockRejectedValue('HTTP 429 Too Many Requests')

      mockAppStore.config.llm_api_key = 'sk-test123'
      render(<LlmPane />)

      fireEvent.click(screen.getByRole('button', { name: /test/i }))

      expect(await screen.findByText('HTTP 429 Too Many Requests')).toBeInTheDocument()
      expect(mockAppStore.setLlmTestStatus).toHaveBeenCalledWith('error')
    })
  })

  describe('AI polish behavior settings', () => {
    it('shows Clean as the default polish style outside advanced settings', () => {
      render(<LlmPane />)

      expect(screen.getByText('Polish style')).toBeInTheDocument()
      expect(screen.getByDisplayValue('Clean')).toBeInTheDocument()
    })

    it('updates the selected polish style without opening advanced settings', () => {
      render(<LlmPane />)

      fireEvent.change(screen.getByDisplayValue('Clean'), { target: { value: 'structured' } })

      expect(mockAppStore.updateConfig).toHaveBeenCalledWith({ polish_style: 'structured' })
      expect(screen.queryByText('Custom polish instructions')).not.toBeInTheDocument()
    })

    it('keeps custom instruction controls inside advanced settings', () => {
      render(<LlmPane />)

      expect(screen.getByText('Advanced polish settings')).toBeInTheDocument()
      expect(screen.queryByText('Optional writing rules')).not.toBeInTheDocument()
      expect(screen.queryByText('Chinese output')).not.toBeInTheDocument()
      expect(screen.queryByText('Custom polish instructions')).not.toBeInTheDocument()
      expect(screen.queryByText('Use selected text as context')).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: /advanced polish settings/i }))

      expect(screen.getByText('Custom polish instructions')).toBeInTheDocument()
      expect(screen.getByText('Use selected text as context')).toBeInTheDocument()
      expect(screen.getByText('Use selected text for context')).toBeInTheDocument()
      expect(screen.queryByText('Chinese output')).not.toBeInTheDocument()
    })

    it('keeps selected-text controls reachable when cleanup is disabled', () => {
      mockAppStore.config.polish_enabled = false
      render(<LlmPane />)

      fireEvent.click(screen.getByRole('button', { name: /advanced polish settings/i }))

      expect(screen.getByText('Use selected text as context')).toBeInTheDocument()
      expect(screen.queryByText('Custom polish instructions')).not.toBeInTheDocument()
    })

    it('updates custom polish instructions from advanced settings', () => {
      render(<LlmPane />)

      fireEvent.click(screen.getByRole('button', { name: /advanced polish settings/i }))
      const textarea = screen.getByPlaceholderText('Example prompt')
      fireEvent.change(textarea, { target: { value: 'Keep a concise professional tone.' } })

      expect(mockAppStore.updateConfig).toHaveBeenCalledWith({
        polish_custom_prompt: 'Keep a concise professional tone.',
      })
    })

    it('opens advanced settings automatically when custom instructions exist', () => {
      mockAppStore.config.polish_custom_prompt = 'Keep it concise.'

      render(<LlmPane />)

      expect(screen.getByText('Custom polish instructions')).toBeInTheDocument()
      expect(screen.queryByText('Chinese output')).not.toBeInTheDocument()
    })

    it('does not expose legacy global active scenes in AI Polish', () => {
      mockAppStore.config.active_scene = {
        id: 'custom_meeting',
        source: 'custom',
        name: 'Meeting Notes',
        prompt_template: 'Use bullets.',
      }

      render(<LlmPane />)

      expect(screen.queryByText('Active scene: Meeting Notes')).not.toBeInTheDocument()
      expect(screen.queryByText('Clear scene')).not.toBeInTheDocument()
    })
  })

  describe('Model input', () => {
    it('does not expose model capability implementation notes in the default flow', async () => {
      vi.mocked(tauri.getLlmModelCapability).mockResolvedValueOnce('certified')
      render(<LlmPane />)

      expect(
        screen.queryByText('Optimized context and thought-aware support'),
      ).not.toBeInTheDocument()
      expect(
        screen.queryByText('Context and thought-aware support is best effort'),
      ).not.toBeInTheDocument()
      expect(tauri.getLlmModelCapability).not.toHaveBeenCalled()
      expect(screen.queryByRole('table')).not.toBeInTheDocument()
    })

    it('keeps model editing available without a best-effort banner', () => {
      render(<LlmPane />)

      expect(
        screen.queryByText('Context and thought-aware support is best effort'),
      ).not.toBeInTheDocument()
      expect(screen.getByPlaceholderText('e.g. gpt-4o-mini')).not.toBeDisabled()
    })

    it('updates config and resets latency when model changes', () => {
      render(<LlmPane />)
      const input = screen.getByPlaceholderText('e.g. gpt-4o-mini')

      fireEvent.change(input, { target: { value: 'gpt-4o' } })

      expect(mockAppStore.updateConfig).toHaveBeenCalledWith({ llm_model: 'gpt-4o' })
      expect(mockAppStore.setLlmLatencyMs).toHaveBeenCalledWith(null)
    })

    it('displays available models count', () => {
      mockAppStore.llmModels = ['gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo']

      render(<LlmPane />)
      expect(screen.getByText('3 models available')).toBeInTheDocument()
    })
  })

  describe('Base URL input', () => {
    it('updates config when base URL changes', () => {
      render(<LlmPane />)
      const input = screen.getByPlaceholderText('https://api.openai.com/v1')

      fireEvent.change(input, { target: { value: 'https://custom.api.com/v1' } })

      expect(mockAppStore.updateConfig).toHaveBeenCalledWith({
        llm_base_url: 'https://custom.api.com/v1',
      })
    })
  })

  describe('Feature toggles', () => {
    it('keeps context adaptation adjacent to AI polish and disables it when polish is off', () => {
      mockAppStore.config.polish_enabled = false
      render(<LlmPane />)

      const contextSwitch = screen
        .getByText('Adapt writing to the current app')
        .closest('label')
        ?.querySelector('[role="switch"]')
      expect(contextSwitch).toBeDisabled()
    })

    it('updates the context adaptation preference', () => {
      render(<LlmPane />)
      const contextSwitch = screen
        .getByText('Adapt writing to the current app')
        .closest('label')
        ?.querySelector('[role="switch"]')
      expect(contextSwitch).not.toBeNull()
      fireEvent.click(contextSwitch!)
      expect(mockAppStore.updateConfig).toHaveBeenCalledWith({
        context_adaptation_enabled: false,
      })
    })

    it('shows a compact noninteractive line of representative adapted apps', () => {
      render(<LlmPane />)

      const coverage = screen.getByLabelText('Apps adapted by context')
      for (const name of [
        'Gmail',
        'Slack',
        'Lark',
        'WeChat',
        'Google Docs',
        'Notion',
        'GitHub',
        'Cursor',
      ]) {
        expect(within(coverage).getByLabelText(name)).toBeInTheDocument()
      }
      expect(within(coverage).getByText('+63')).toBeInTheDocument()
      expect(within(coverage).getByText('+65')).toHaveClass('context-app-count--compact')
      expect(within(coverage).getByLabelText('Lark')).toHaveClass('context-app--compact-duplicate')
      expect(within(coverage).getByLabelText('Notion')).toHaveClass(
        'context-app--compact-duplicate',
      )
      expect(within(coverage).queryByRole('button')).not.toBeInTheDocument()
      expect(within(coverage).queryByRole('link')).not.toBeInTheDocument()
      expect(coverage).toHaveAttribute('aria-disabled', 'false')
      expect(coverage).toHaveClass('gap-1')
    })

    it('dims representative apps whenever app adaptation is not active', () => {
      mockAppStore.config.context_adaptation_enabled = false
      render(<LlmPane />)

      expect(screen.getByLabelText('Apps adapted by context')).toHaveAttribute(
        'aria-disabled',
        'true',
      )
    })

    it('keeps helper copy and advanced toggles out of the default flow', () => {
      render(<LlmPane />)

      expect(screen.queryByText('Cleans up dictation before output')).not.toBeInTheDocument()
      expect(screen.queryByText('Translate each dictation result')).not.toBeInTheDocument()
      expect(screen.queryByText('Uses a private local app category')).not.toBeInTheDocument()
      expect(screen.queryByText('Use selected text as context')).not.toBeInTheDocument()
      expect(screen.queryByText('Use selected text for context')).not.toBeInTheDocument()
    })

    it('hides last context until an operation snapshot exists', () => {
      render(<LlmPane />)
      expect(screen.queryByText('Last dictation context')).not.toBeInTheDocument()
    })

    it('shows only the safe last operation context after dictation', () => {
      mockAppStore.lastContext = {
        profileId: 'chat.slack',
        family: 'work_chat',
        appLabel: 'Slack',
        iconKey: 'slack',
        overrideId: 'slack',
        browserAccessStatus: 'available',
      }
      render(<LlmPane />)

      expect(screen.getByText('Last dictation context')).toBeInTheDocument()
      expect(screen.getByText('Slack')).toBeInTheDocument()
      expect(screen.queryByText(/window|host|confidence/i)).not.toBeInTheDocument()
    })

    it('shows a short browser access hint when browser context needs URL access', () => {
      mockAppStore.lastContext = {
        profileId: 'general.browser',
        family: 'general',
        appLabel: 'Browser',
        iconKey: 'general',
        overrideId: null,
        browserAccessStatus: 'needs_permission',
      }

      render(<LlmPane />)

      expect(
        screen.getByText('Allow browser access to use Gmail, Docs, and Slack Web modes.'),
      ).toBeInTheDocument()
    })

    it('keeps the app-style overflow hidden without a live candidate or user mappings', async () => {
      mockAppStore.lastContext = {
        profileId: 'chat.slack',
        family: 'work_chat',
        appLabel: 'Slack',
        iconKey: 'slack',
        overrideId: 'slack',
        browserAccessStatus: 'available',
      }

      render(<LlmPane />)

      await waitFor(() => expect(tauri.listCustomAppMappings).toHaveBeenCalled())
      expect(screen.queryByRole('button', { name: 'App writing style' })).not.toBeInTheDocument()
    })

    it('opens one compact writing-style dialog from a live safe candidate', async () => {
      mockAppStore.lastContext = {
        profileId: 'general.browser',
        family: 'general',
        appLabel: 'Example',
        iconKey: 'general',
        overrideId: null,
        browserAccessStatus: 'available',
      }
      vi.mocked(tauri.getLatestMappingCandidate).mockResolvedValue({
        generation: 7,
        matcherType: 'exact_web_host',
        displayValue: 'docs.example.com',
        suggestedLabel: 'docs.example.com',
        currentFamily: 'document',
        iconKey: 'general',
      })

      render(<LlmPane />)

      fireEvent.click(await screen.findByRole('button', { name: 'App writing style' }))
      fireEvent.click(screen.getByText('Use a different writing style'))

      expect(
        await screen.findByRole('dialog', { name: 'Writing style for this app' }),
      ).toBeVisible()
      expect(screen.getByText('docs.example.com')).toBeInTheDocument()
    })

    it('shows mapping management only for user-created mappings', async () => {
      mockAppStore.lastContext = {
        profileId: 'chat.slack',
        family: 'work_chat',
        appLabel: 'Slack',
        iconKey: 'slack',
        overrideId: 'slack',
        browserAccessStatus: 'available',
      }
      vi.mocked(tauri.listCustomAppMappings).mockResolvedValue([
        {
          id: 'mapping-1',
          label: 'Work Slack',
          matcherType: 'native_bundle_id',
          displayValue: 'Work Slack · macOS',
          family: 'work_chat',
          sceneId: null,
          enabled: true,
          iconKey: 'slack',
        },
      ])

      render(<LlmPane />)

      fireEvent.click(await screen.findByRole('button', { name: 'App writing style' }))
      expect(screen.getByText('Manage app mappings')).toBeInTheDocument()
      expect(screen.queryByText('Use a different writing style')).not.toBeInTheDocument()
      expect(screen.queryByText('Gmail')).not.toBeInTheDocument()
    })

    it('shows a compact translate-to control next to translation when enabled', () => {
      mockAppStore.config.translate_enabled = true

      render(<LlmPane />)
      expect(screen.getByText('Translate to')).toBeInTheDocument()
      expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    })
  })
})
