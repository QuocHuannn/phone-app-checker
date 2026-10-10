import type { Adapter, App, PhoneNumber } from '../types.ts';

/** Which numbers each app is checked for. Numbers outside the scope are reported as `skipped`. */
export const APP_SCOPE: Record<App, (n: PhoneNumber) => boolean> = {
  telegram: () => true,
  whatsapp: () => true,
  // Zalo is a Vietnam-only service.
  zalo: (n) => n.country === 'VN',
  viber: () => true,
  line: () => true,
  // Threema's lookup is by phone hash and works for any region; only users who linked a number are found.
  threema: () => true,
  // Matrix's lookup is by hashed phone number and works for any region; only users who linked a number to an identity server are found.
  matrix: () => true,
};

/**
 * Adapter modules are selected at runtime from the apps the user enabled. They are
 * imported dynamically on purpose: each pulls a large unofficial client library, and a
 * library that fails to load (protocol change, missing native dep) must not break the
 * other apps or the `report` command.
 */
export async function loadAdapter(app: App): Promise<Adapter> {
  try {
    switch (app) {
      case 'telegram':
        return (await import('./telegram.ts')).telegramAdapter;
      case 'whatsapp':
        return (await import('./whatsapp.ts')).whatsappAdapter;
      case 'zalo':
        return (await import('./zalo.ts')).zaloAdapter;
      case 'viber':
        return (await import('./viber.ts')).viberAdapter;
      case 'line':
        return (await import('./line.ts')).lineAdapter;
      case 'threema':
        return (await import('./threema.ts')).threemaAdapter;
      case 'matrix':
        return (await import('./matrix.ts')).matrixAdapter;
    }
  } catch (error) {
    throw new Error(`Cannot load the ${app} adapter: ${(error as Error).message}`, { cause: error });
  }
}
