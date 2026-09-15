import { describe, expect, it } from 'vitest'
import {
  LLM_DEFAULT_CONFIG,
  LLM_PROVIDERS,
  ONBOARDING_LLM_PROVIDERS,
  llmProviderRequiresApiKey,
} from '../constants'
import type { LlmProvider } from '../../stores/appStore'

describe('Agent Maestro provider metadata', () => {
  it('adds Agent Maestro to the provider lists with a blank default model', () => {
    expect(LLM_PROVIDERS).toContainEqual({
      value: 'agent-maestro',
      labelKey: 'providers.llm.agentMaestro',
    })
    expect(ONBOARDING_LLM_PROVIDERS).toContainEqual({
      value: 'agent-maestro',
      labelKey: 'providers.llm.agentMaestro',
    })
    expect(ONBOARDING_LLM_PROVIDERS).not.toContainEqual(
      expect.objectContaining({ value: 'cloud' }),
    )
    expect(LLM_DEFAULT_CONFIG['agent-maestro']).toEqual({
      baseUrl: 'http://127.0.0.1:23333/api/openai/v1',
      model: '',
    })
  })

  it('treats Agent Maestro as a valid LLM provider literal', () => {
    const provider: LlmProvider = 'agent-maestro'

    expect(provider).toBe('agent-maestro')
  })

  it('requires API keys for remote providers but not Ollama or Agent Maestro', () => {
    expect(llmProviderRequiresApiKey(' agent-maestro ')).toBe(false)
    expect(llmProviderRequiresApiKey(' OLLAMA ')).toBe(false)
    expect(llmProviderRequiresApiKey('openai')).toBe(true)
  })

  it('keeps existing provider defaults unchanged', () => {
    expect(LLM_DEFAULT_CONFIG.openai).toEqual({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    })
    expect(LLM_DEFAULT_CONFIG.cloud.model).toBe('default')
  })
})
