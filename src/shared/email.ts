import { config } from '../config'

// Resend vía API HTTP directa (sin SDK). Sin RESEND_API_KEY: log-only.
export async function sendEmail(to: string, subject: string, html: string) {
  if (!config.resendApiKey) {
    console.log(`[email] (log-only) → ${to} | ${subject}`)
    return
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.emailFrom, to, subject, html }),
  })
  if (!res.ok) console.error(`[email] fallo Resend ${res.status}: ${await res.text()}`)
}
