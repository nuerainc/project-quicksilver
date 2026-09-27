/** Build the channel adapters whose settings are present in the environment. */
import { DiscordAdapter } from './discord.ts'
import { EmailAdapter } from './email.ts'
import { SlackAdapter } from './slack.ts'
import { TelegramAdapter } from './telegram.ts'
import { TwilioSmsAdapter } from './twilio.ts'
import type { ChannelAdapter } from './types.ts'

export function adaptersFromEnv(env: Readonly<Record<string, string | undefined>>): { adapters: ChannelAdapter[]; sms?: TwilioSmsAdapter; email?: EmailAdapter } {
  const adapters: ChannelAdapter[] = []
  const publicUrl = env.QUICKSILVER_GATEWAY_PUBLIC_URL?.replace(/\/+$/, '')
  if (env.TELEGRAM_BOT_TOKEN) adapters.push(new TelegramAdapter({ token: env.TELEGRAM_BOT_TOKEN }))
  if (env.SLACK_APP_TOKEN && env.SLACK_BOT_TOKEN) adapters.push(new SlackAdapter({ appToken: env.SLACK_APP_TOKEN, botToken: env.SLACK_BOT_TOKEN }))
  if (env.DISCORD_BOT_TOKEN) adapters.push(new DiscordAdapter({ token: env.DISCORD_BOT_TOKEN }))
  const sms = env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM && publicUrl
    ? new TwilioSmsAdapter({ accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, from: env.TWILIO_FROM, webhookUrl: `${publicUrl}/inbound/sms` })
    : undefined
  if (sms) adapters.push(sms)
  const email = env.QUICKSILVER_EMAIL_FROM && env.QUICKSILVER_EMAIL_API_KEY && env.QUICKSILVER_EMAIL_INBOUND_SECRET
    ? new EmailAdapter({ from: env.QUICKSILVER_EMAIL_FROM, apiKey: env.QUICKSILVER_EMAIL_API_KEY, inboundSecret: env.QUICKSILVER_EMAIL_INBOUND_SECRET })
    : undefined
  if (email) adapters.push(email)
  return { adapters, sms, email }
}
