function isEnabled() {
  return String(process.env.TELEGRAM_ALERTS_ENABLED || 'false').toLowerCase() === 'true';
}

function readConfig() {
  return {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
    maxMessagesPerRun: Number(process.env.TELEGRAM_MAX_MESSAGES_PER_RUN || 20),
  };
}

function normalizeRecipient(value) {
  return String(value || '').trim();
}

function resolveRecipients(recipients, fallback) {
  const list = (Array.isArray(recipients) ? recipients : [])
    .map((value) => normalizeRecipient(value))
    .filter(Boolean);
  if (list.length > 0) {
    return [...new Set(list)];
  }

  const fallbackValue = normalizeRecipient(fallback);
  return fallbackValue ? [fallbackValue] : [];
}

function formatPrice(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : 'n/a';
}

function truncateText(value, maxLength = 120) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}...`;
}

function buildCandidateMessage(row, checkTimestamp) {
  return [
    '[Ticker Alert Candidate]',
    `Ticker: ${row.ticker}`,
    `Company: ${truncateText(row.description || 'n/a')}`,
    `Current Price: ${formatPrice(row.price)} ${row.currency || ''}`.trim(),
    `Check Time: ${checkTimestamp}`,
  ].join('\n');
}

async function sendTelegramMessage({ botToken, chatId, text }) {
  const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegram send failed: ${response.status}`);
  }

  const payload = await response.json();
  if (!payload?.ok) {
    throw new Error('Telegram API returned non-ok response');
  }
}

function createTelegramSender() {
  const enabled = isEnabled();
  const cfg = readConfig();

  if (!enabled) {
    return {
      enabled,
      async sendTest() {
        return { sent: 0, failed: 0, reason: 'disabled' };
      },
      async sendCandidates() {
        return { sent: 0, failed: 0, skipped: 0, reason: 'disabled' };
      },
    };
  }

  if (!cfg.botToken) {
    return {
      enabled,
      async sendTest() {
        return { sent: 0, failed: 0, reason: 'missing-config' };
      },
      async sendCandidates() {
        return { sent: 0, failed: 0, skipped: 0, reason: 'missing-config' };
      },
    };
  }

  return {
    enabled,
    async sendTest({ text, recipients = null } = {}) {
      const recipientList = resolveRecipients(recipients, cfg.chatId);
      if (recipientList.length === 0) {
        return { sent: 0, failed: 0, reason: 'no-recipients' };
      }

      const body = text || `[Ticker Monitor Test]\nTime: ${new Date().toISOString()}\nIf you got this, Telegram alerts are configured correctly.`;
      let sent = 0;
      let failed = 0;

      for (const chatId of recipientList) {
        try {
          await sendTelegramMessage({
            botToken: cfg.botToken,
            chatId,
            text: body,
          });
          sent += 1;
        } catch {
          failed += 1;
        }
      }

      return { sent, failed, reason: sent > 0 ? 'ok' : 'send-failed' };
    },
    async sendCandidates(candidateRows, { checkTimestamp, recipients = null } = {}) {
      const rows = Array.isArray(candidateRows) ? candidateRows : [];
      const recipientList = resolveRecipients(recipients, cfg.chatId);

      if (recipientList.length === 0) {
        return { sent: 0, failed: 0, skipped: 0, reason: 'no-recipients' };
      }

      if (rows.length === 0) {
        return { sent: 0, failed: 0, skipped: 0, reason: 'no-alerts' };
      }

      const max = Number.isFinite(cfg.maxMessagesPerRun) ? Math.max(1, cfg.maxMessagesPerRun) : 20;
      const toSend = rows.slice(0, max);
      const skipped = Math.max(0, rows.length - toSend.length);

      let sent = 0;
      let failed = 0;

      const timeLabel = checkTimestamp || new Date().toISOString();
      for (const row of toSend) {
        const text = buildCandidateMessage(row, timeLabel);
        for (const chatId of recipientList) {
          try {
            await sendTelegramMessage({
              botToken: cfg.botToken,
              chatId,
              text,
            });
            sent += 1;
          } catch {
            failed += 1;
          }
        }
      }

      return {
        sent,
        failed,
        skipped,
        reason: 'ok',
      };
    },
  };
}

module.exports = {
  createTelegramSender,
};
