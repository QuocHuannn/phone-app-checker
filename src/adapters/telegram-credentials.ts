/** Telegram API credentials lookup. Kept free of heavy imports so `doctor` can use it without loading mtcute. */
export function readTelegramCredentials(
  options: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): { apiId: number; apiHash: string } {
  const rawId = options.apiId ?? env.TELEGRAM_API_ID;
  const rawHash = options.apiHash ?? env.TELEGRAM_API_HASH;
  const apiId = typeof rawId === 'number' ? rawId : Number(String(rawId ?? '').trim());
  const apiHash = typeof rawHash === 'string' ? rawHash.trim() : '';
  if (!Number.isInteger(apiId) || apiId <= 0 || apiHash === '') {
    throw new Error(
      'Telegram API credentials missing. Set TELEGRAM_API_ID and TELEGRAM_API_HASH ' +
        '(or apps.telegram.options.apiId / apiHash in checker.config.json). ' +
        'Create them at https://my.telegram.org/apps - see docs/telegram-setup.md.',
    );
  }
  return { apiId, apiHash };
}
