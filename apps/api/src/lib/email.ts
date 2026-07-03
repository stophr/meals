import { env } from '../env.js';

// EMAIL DELIVERY IS A STUB. Pantrezy is passwordless — sign-in and org/user invites are magic
// links emailed to the address. Until the pantrezy.com domain + a mail provider are set up,
// this logs the link (and returns it in non-production so the flow is testable end-to-end).
//
// TODO (when pantrezy.com is live): swap in a real transport (Resend/Postmark/SES) here; no
// caller changes needed. Set WEB_BASE_URL and the provider key in env.
export async function sendMagicLink(email: string, url: string, purpose: string): Promise<{ delivered: boolean; devUrl?: string }> {
  // eslint-disable-next-line no-console
  console.log(`[email:STUB] ${purpose} link for ${email}: ${url}`);
  const dev = env.NODE_ENV !== 'production';
  return { delivered: false, devUrl: dev ? url : undefined };
}
