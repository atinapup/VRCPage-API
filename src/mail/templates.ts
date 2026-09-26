/*
 * Every email vrc.page sends, and the one layout they share.
 *
 * Written as data, not markup: each template returns a heading, some
 * paragraphs and at most one thing to press, and `render` turns that into the
 * HTML and the plain-text alternative. The copy is therefore all in one place
 * and readable, and there is exactly one table layout to get right.
 *
 * Why the HTML looks like 2005: email clients are not browsers. Outlook on
 * Windows renders with Word, Gmail strips <style> in parts of its app, and
 * nothing supports modern layout. So: tables, inline styles, one column,
 * 600px, and no image that the message depends on.
 *
 * Dark mode is handled by sending a light message and letting the clients
 * that support prefers-color-scheme (Apple Mail, iOS, Outlook for Mac) swap
 * to the site's dark palette. A light base survives the clients that invert
 * colours themselves, which a dark base does not.
 *
 * The colours are the site's, measured: on white, body text 18.7:1, quiet
 * text 7.5:1, the accent as a link 4.8:1 and white on the accent 4.8:1. In
 * the dark block, 15.5:1, 7.7:1 and 6.1:1 against the card.
 */

const LIGHT = {
  page: '#F4F1F1',
  card: '#FFFFFF',
  ink: '#161111',
  muted: '#5C5252',
  line: '#E6E0E0',
  accent: '#D92D3A',
} as const;

const DARK = {
  page: '#161111',
  card: '#201A1A',
  ink: '#F7F2F2',
  muted: '#B7ABAA',
  line: '#332B2B',
  /** The accent lifted to OKLCH lightness 0.74, the same rule as the site's --brand. */
  accent: '#FF696A',
} as const;

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

/** What a template says. Nothing here is markup; `render` decides how it looks. */
export type Content = {
  subject: string;
  /** The line clients show next to the subject. Never a repeat of it. */
  preheader: string;
  heading: string;
  paragraphs: string[];
  /** A code to read off the screen and type in, shown large. */
  code?: string;
  action?: { label: string; url: string };
  /** The quiet line above the footer: usually what to do if this wasn't you. */
  note?: string;
};

export type TemplateProps = {
  sign_in_code: { code: string; minutes: number };
  email_change_code: { code: string; minutes: number };
  welcome: { dashboardUrl: string };
  name_claimed: { slug: string; pageUrl: string; cooldownDays: number };
  account_deleted: { tombstoneDays: number };
};

export type TemplateName = keyof TemplateProps;

/**
 * Props that must never reach mail.messages: a stored sign-in code would
 * make the outbox as good as the mailbox.
 */
const NEVER_STORED = ['code'];

export function storableProps(props: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(props).filter(([key]) => !NEVER_STORED.includes(key)));
}

const TEMPLATES: { [K in TemplateName]: (props: TemplateProps[K]) => Content } = {
  sign_in_code: ({ code, minutes }) => ({
    subject: `${code} is your vrc.page sign-in code`,
    preheader: `Type it on the sign-in page. It works for the next ${minutes} minutes.`,
    heading: 'Sign in to vrc.page',
    paragraphs: ['Type this code on the sign-in page:'],
    code,
    note: `The code works once, and only for the next ${minutes} minutes. If you didn't ask to sign in, nothing has happened: ignore this email and nobody gets in.`,
  }),

  email_change_code: ({ code, minutes }) => ({
    subject: `${code} confirms your new vrc.page address`,
    preheader: `Type it in Settings. It works for the next ${minutes} minutes.`,
    heading: 'Confirm this address',
    paragraphs: ['Type this code in Settings to move your vrc.page account to this address:'],
    code,
    note: `The code works once, and only for the next ${minutes} minutes. If you didn't ask to change your email address, ignore this: your account stays where it is.`,
  }),

  welcome: ({ dashboardUrl }) => ({
    subject: 'Welcome to vrc.page',
    preheader: 'Connect VRChat, pick a name, and your page is live.',
    heading: 'Your account is ready',
    paragraphs: [
      'Two things left, and both are quick. Connect your VRChat account, which proves the profile is yours, then pick the name your page lives at.',
      'After that your page is live and stays up to date on its own.',
    ],
    action: { label: 'Set up your page', url: dashboardUrl },
    note: 'You can change your name later, and take the page down whenever you like.',
  }),

  name_claimed: ({ slug, pageUrl, cooldownDays }) => ({
    subject: `vrc.page/${slug} is yours`,
    preheader: 'Your page is live at its new address.',
    heading: 'Your page is live',
    paragraphs: [`It's at vrc.page/${slug}, and anyone with the link can open it.`],
    action: { label: 'View your page', url: pageUrl },
    note: `The name is held for you. You can change it again after ${cooldownDays} days, and the old one is kept out of reach for a while so an old link can't lead somewhere unexpected.`,
  }),

  account_deleted: ({ tombstoneDays }) => ({
    subject: 'Your vrc.page account is deleted',
    preheader: 'Your pages are down and your data is gone.',
    heading: 'Your account is deleted',
    paragraphs: [
      'Your pages are down, your VRChat connection is cut, and the groups you claimed are released. Anyone you had invited to edit them has lost access.',
      `Your page names are held for ${tombstoneDays} days before anyone else can take them, so links that were shared don't quietly lead somewhere else.`,
    ],
    note: "This is the last email we'll send you.",
  }),
};

export function content<K extends TemplateName>(template: K, props: TemplateProps[K]): Content {
  return TEMPLATES[template](props);
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Everything interpolated into the HTML goes through here: names and slugs are user content. */
function escape(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

/**
 * The one layout. Two tables: the page, and the 600px card inside it. The
 * dark palette and the small-screen padding are the only rules in <style>,
 * because everything else has to survive a client that drops the whole block.
 */
function html(content: Content, unsubscribeUrl: string | null): string {
  const rows: string[] = [];

  // The name, with its accent dot. On the site the dot is a drawn circle; a
  // coloured full stop, set larger, is the version that survives Outlook.
  rows.push(`<tr><td style="padding:32px 32px 0 32px;font:600 17px/1.4 ${FONT};color:${LIGHT.ink};letter-spacing:-0.01em"
      class="pad ink">vrc<span style="color:${LIGHT.accent};font-size:23px" class="accent">.</span>page</td></tr>`);

  rows.push(`<tr><td style="padding:22px 32px 0 32px;font:700 24px/1.25 ${FONT};color:${LIGHT.ink};letter-spacing:-0.02em"
      class="pad ink">${escape(content.heading)}</td></tr>`);

  for (const paragraph of content.paragraphs) {
    rows.push(`<tr><td style="padding:14px 32px 0 32px;font:400 16px/1.6 ${FONT};color:${LIGHT.ink}"
        class="pad ink">${escape(paragraph)}</td></tr>`);
  }

  if (content.code) {
    // Letter-spaced, boxed, and selectable: it is read off the screen and
    // typed into six boxes, so the characters have to be told apart.
    rows.push(`<tr><td class="pad" style="padding:22px 32px 0 32px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
        <td align="center" bgcolor="${LIGHT.page}" class="well"
            style="padding:18px 12px;border-radius:12px;border:1px solid ${LIGHT.line};font:700 30px/1.2 ${MONO};letter-spacing:0.18em;color:${LIGHT.ink}">${escape(content.code)}</td>
      </tr></table></td></tr>`);
  }

  if (content.action) {
    // A table cell, not a styled anchor: Outlook ignores padding on inline
    // elements. Square corners there, rounded everywhere else.
    rows.push(`<tr><td class="pad" style="padding:24px 32px 0 32px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td bgcolor="${LIGHT.accent}" style="border-radius:10px">
          <a href="${escape(content.action.url)}"
             style="display:inline-block;padding:15px 22px;font:600 15px/1 ${FONT};color:#FFFFFF;text-decoration:none;border-radius:10px">${escape(content.action.label)}</a>
        </td>
      </tr></table></td></tr>`);
    rows.push(`<tr><td style="padding:12px 32px 0 32px;font:400 13px/1.6 ${FONT};color:${LIGHT.muted}"
        class="pad muted">Or paste this into your browser:<br /><a href="${escape(content.action.url)}"
        style="color:${LIGHT.accent};text-decoration:underline" class="accent">${escape(content.action.url)}</a></td></tr>`);
  }

  if (content.note) {
    rows.push(`<tr><td class="pad" style="padding:24px 32px 0 32px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
        <td style="border-top:1px solid ${LIGHT.line};padding-top:20px;font:400 14px/1.6 ${FONT};color:${LIGHT.muted}"
            class="line muted">${escape(content.note)}</td>
      </tr></table></td></tr>`);
  }

  const unsubscribe = unsubscribeUrl
    ? `<br /><a href="${escape(unsubscribeUrl)}" style="color:${LIGHT.muted};text-decoration:underline" class="muted">Stop getting emails like this</a>`
    : '';
  rows.push(`<tr><td style="padding:28px 32px 32px 32px;font:400 12px/1.6 ${FONT};color:${LIGHT.muted}"
      class="pad muted">vrc.page is an independent project and is not affiliated with, endorsed by, or sponsored by VRChat Inc.${unsubscribe}</td></tr>`);

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light dark" />
<meta name="supported-color-schemes" content="light dark" />
<title>${escape(content.subject)}</title>
<style>
  @media (prefers-color-scheme: dark) {
    .page { background:${DARK.page} !important; }
    .card { background:${DARK.card} !important; border-color:${DARK.line} !important; }
    .ink { color:${DARK.ink} !important; }
    .muted { color:${DARK.muted} !important; }
    .accent { color:${DARK.accent} !important; }
    .line { border-color:${DARK.line} !important; }
    .well { background:${DARK.page} !important; border-color:${DARK.line} !important; color:${DARK.ink} !important; }
  }
  @media only screen and (max-width:620px) {
    /* A table ignores max-width while it has a width, so the width goes here. */
    .card { width:100% !important; }
    .pad { padding-left:22px !important; padding-right:22px !important; }
  }
</style>
</head>
<body class="page" style="margin:0;padding:0;background:${LIGHT.page};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${escape(content.preheader)}&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;&#8203;</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="page" style="background:${LIGHT.page}">
<tr><td align="center" style="padding:28px 12px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" class="card"
       style="width:600px;max-width:100%;background:${LIGHT.card};border:1px solid ${LIGHT.line};border-radius:16px">
${rows.join('\n')}
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** The same message for a client showing plain text, and for the ones that score HTML-only mail as spam. */
function text(content: Content, unsubscribeUrl: string | null): string {
  const lines = [content.heading, '', ...content.paragraphs.flatMap((paragraph) => [paragraph, ''])];
  if (content.code) lines.push(content.code, '');
  if (content.action) lines.push(`${content.action.label}: ${content.action.url}`, '');
  if (content.note) lines.push(content.note, '');
  lines.push('--', 'vrc.page is an independent project and is not affiliated with, endorsed by, or sponsored by VRChat Inc.');
  if (unsubscribeUrl) lines.push(`Stop getting emails like this: ${unsubscribeUrl}`);
  return lines.join('\n');
}

export type Rendered = { subject: string; html: string; text: string };

export function render(content: Content, unsubscribeUrl: string | null = null): Rendered {
  return { subject: content.subject, html: html(content, unsubscribeUrl), text: text(content, unsubscribeUrl) };
}
