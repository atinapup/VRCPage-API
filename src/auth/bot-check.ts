/*
 * Cloudflare Turnstile, in front of every sign-in code.
 *
 * A code is an email vrc.page sends to an address someone typed. Without a
 * check, a script can make the site send thousands of them, to strangers, on
 * vrc.page's sending reputation. The widget runs in the browser (the website
 * holds its site key) and hands the form a token; this trades that token with
 * Cloudflare for a yes or no before anything is sent.
 */

const SITE_VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Named on the widget and checked on the answer, so a token made for another form can't be spent here. */
const ACTION = 'sign-in';

/** Long enough for a slow answer, short enough that nobody waits on a hang. */
const TIMEOUT_MS = 10_000;

type SiteVerifyAnswer = {
  success?: boolean;
  action?: string;
  metadata?: { result_with_testing_key?: boolean };
};

/**
 * "unavailable" means there is no verdict at all: no secret on this server,
 * or Cloudflare didn't answer. Both fail closed.
 */
export async function passesBotCheck(
  secret: string | null,
  token: string,
  ip: string | null,
): Promise<'passed' | 'failed' | 'unavailable'> {
  if (!secret) {
    console.error('No sign-in code was sent: TURNSTILE_SECRET_KEY is not set.');
    return 'unavailable';
  }
  // Cloudflare caps tokens at 2048 characters. Anything empty or longer is not one.
  if (!token || token.length > 2048) return 'failed';

  let answer: SiteVerifyAnswer;
  try {
    const response = await fetch(SITE_VERIFY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    answer = (await response.json()) as SiteVerifyAnswer;
  } catch (error) {
    console.error('Checking the Turnstile token failed.', error);
    return 'unavailable';
  }

  if (answer.success !== true) return 'failed';
  // The test keys answer without an action. Real ones always carry one.
  if (!answer.metadata?.result_with_testing_key && answer.action !== ACTION) return 'failed';
  return 'passed';
}
