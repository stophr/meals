import { createClient } from '@meals/shared';

const baseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3001';

export const api = createClient({ baseUrl });
