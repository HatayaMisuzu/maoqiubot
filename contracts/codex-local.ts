// Use the built-in provider and its official endpoints, including when CC Switch is active.
export const codexServiceArgs = [
  '-c', 'model_provider="openai"',
  '-c', 'forced_login_method="chatgpt"',
  '-c', 'openai_base_url="https://chatgpt.com/backend-api/codex"',
  '-c', 'chatgpt_base_url="https://chatgpt.com/backend-api/"'
]

export function codexEnvironment(source: NodeJS.ProcessEnv) {
  const env = { ...source }
  for (const key of Object.keys(env)) {
    if (/^(?:(?:NODE_TOKEN|OWNER_TOKEN|OPENAI_BASE_URL|OPENAI_API_BASE|CHATGPT_BASE_URL|CODEX_ACCESS_TOKEN|CODEX_API_KEY|OPENAI_API_KEY|ACCESS_TOKEN)$|MAOQIU_MODEL_KEY_)/i.test(key)) delete env[key]
  }
  return env
}
