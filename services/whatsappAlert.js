const twilio = require('twilio');

function isEnabled() {
  return String(process.env.WHATSAPP_ALERTS_ENABLED || 'false').toLowerCase() === 'true';
}

function readConfig() {
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    from: process.env.TWILIO_WHATSAPP_FROM || '',
    to: process.env.TWILIO_WHATSAPP_TO || '',
    digestMode: (process.env.WHATSAPP_DIGEST_MODE || 'single').toLowerCase(),
    maxMessagesPerRun: Number(process.env.WHATSAPP_MAX_MESSAGES_PER_RUN || 5),
  };
}

function buildMessage(alertRow) {
  const direction = Number(alertRow.change_pct) >= 0 ? 'UP' : 'DOWN';
  return [
    '[Ticker Alert]',
    `${alertRow.ticker} ${direction} ${Math.abs(Number(alertRow.change_pct)).toFixed(2)}%`,
    `Old: ${alertRow.old_price}`,
    `New: ${alertRow.new_price}`,
    `Threshold: ${alertRow.threshold_pct}%`,
    `Time: ${alertRow.timestamp}`,
  ].join('\n');
}

function buildDigestMessage(alertRows) {
  const lines = ['[Ticker Digest]', `Alerts this run: ${alertRows.length}`];

  const topRows = [...alertRows]
    .sort((a, b) => Math.abs(Number(b.change_pct)) - Math.abs(Number(a.change_pct)))
    .slice(0, 15);

  for (const row of topRows) {
    const change = Number(row.change_pct);
    const direction = change >= 0 ? 'UP' : 'DOWN';
    lines.push(`${row.ticker}: ${direction} ${Math.abs(change).toFixed(2)}% (${row.old_price} -> ${row.new_price})`);
  }

  if (alertRows.length > topRows.length) {
    lines.push(`...and ${alertRows.length - topRows.length} more.`);
  }

  return lines.join('\n');
}

function createWhatsAppSender() {
  const enabled = isEnabled();
  const cfg = readConfig();

  if (!enabled) {
    return {
      enabled,
      async sendTest() {
        return { sent: 0, failed: 0, reason: 'disabled', mode: 'off' };
      },
      async sendAlerts() {
        return { sent: 0, failed: 0, skipped: 0, reason: 'disabled', mode: 'off' };
      },
    };
  }

  if (!cfg.accountSid || !cfg.authToken || !cfg.from || !cfg.to) {
    return {
      enabled,
      async sendTest() {
        return { sent: 0, failed: 0, reason: 'missing-config', mode: cfg.digestMode };
      },
      async sendAlerts() {
        return { sent: 0, failed: 0, skipped: 0, reason: 'missing-config', mode: cfg.digestMode };
      },
    };
  }

  const client = twilio(cfg.accountSid, cfg.authToken);

  return {
    enabled,
    async sendTest({ text } = {}) {
      const body = text || `[Ticker Monitor Test]\nTime: ${new Date().toISOString()}\nIf you got this, WhatsApp alerts are configured correctly.`;
      try {
        await client.messages.create({
          from: cfg.from,
          to: cfg.to,
          body,
        });

        return {
          sent: 1,
          failed: 0,
          reason: 'ok',
          mode: cfg.digestMode === 'single' ? 'single' : 'multiple',
        };
      } catch {
        return {
          sent: 0,
          failed: 1,
          reason: 'send-failed',
          mode: cfg.digestMode === 'single' ? 'single' : 'multiple',
        };
      }
    },
    async sendAlerts(alertRows) {
      const rows = Array.isArray(alertRows) ? alertRows : [];
      const digestMode = cfg.digestMode === 'single' ? 'single' : 'multiple';

      if (rows.length === 0) {
        return {
          sent: 0,
          failed: 0,
          skipped: 0,
          reason: 'no-alerts',
          mode: digestMode,
        };
      }

      if (digestMode === 'single') {
        const body = buildDigestMessage(rows);
        try {
          await client.messages.create({
            from: cfg.from,
            to: cfg.to,
            body,
          });

          return {
            sent: 1,
            failed: 0,
            skipped: 0,
            reason: 'ok',
            mode: digestMode,
          };
        } catch {
          return {
            sent: 0,
            failed: 1,
            skipped: 0,
            reason: 'send-failed',
            mode: digestMode,
          };
        }
      }

      const max = Number.isFinite(cfg.maxMessagesPerRun) ? Math.max(1, cfg.maxMessagesPerRun) : 5;
      const toSend = rows.slice(0, max);
      const skipped = Math.max(0, rows.length - toSend.length);

      let sent = 0;
      let failed = 0;

      for (const row of toSend) {
        const body = buildMessage(row);
        try {
          await client.messages.create({
            from: cfg.from,
            to: cfg.to,
            body,
          });
          sent += 1;
        } catch {
          failed += 1;
        }
      }

      return {
        sent,
        failed,
        skipped,
        reason: 'ok',
        mode: digestMode,
      };
    },
  };
}

module.exports = {
  createWhatsAppSender,
};
