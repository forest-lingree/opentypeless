import { useTranslation } from 'react-i18next'
import type { AzureOpenAiConfig } from '../lib/tauri'

export function AzureOpenAiFields({
  value,
  onChange,
  speech = false,
}: {
  value: AzureOpenAiConfig
  onChange: (patch: Partial<AzureOpenAiConfig>) => void
  speech?: boolean
}) {
  const { t } = useTranslation()
  return (
    <>
      {(['endpoint', 'deployment', 'apiVersion'] as const).map((field) => {
        const label = t(
          `azure.${field === 'endpoint' ? 'resourceEndpoint' : field === 'deployment' ? 'deploymentName' : 'apiVersion'}`,
        )
        return (
          <label key={field} className="block text-[13px] font-medium text-text-secondary">
            <span className="block mb-2">{label}</span>
            <input
              aria-label={label}
              value={value[field]}
              onChange={(event) => onChange({ [field]: event.target.value })}
              placeholder={
                field === 'endpoint'
                  ? 'https://your-resource.openai.azure.com'
                  : field === 'apiVersion'
                    ? '2024-10-21'
                    : label
              }
              className="w-full px-3 py-2.5 bg-bg-secondary border border-border rounded-[10px] text-[13px] text-text-primary outline-none focus:border-border-focus transition-colors"
            />
          </label>
        )
      })}
      <p className="text-[12px] text-text-tertiary">{t('azure.endpointHint')}</p>
      <p className="text-[12px] text-text-tertiary">{t('azure.deploymentHint')}</p>
      {speech && <p className="text-[12px] text-text-tertiary">{t('azure.bufferedSttHint')}</p>}
    </>
  )
}
