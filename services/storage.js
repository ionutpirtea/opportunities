const fs = require('node:fs/promises');
const path = require('node:path');

async function ensureCsv(filePath, headers) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  try {
    await fs.access(filePath);
  } catch {
    const headerLine = `${headers.join(',')}\n`;
    await fs.writeFile(filePath, headerLine, 'utf8');
  }
}

function serializeCsvRow(headers, row) {
  return headers
    .map((header) => {
      const value = row[header] ?? '';
      const text = String(value);
      if (text.includes(',') || text.includes('"') || text.includes('\n')) {
        return `"${text.replace(/"/g, '""')}"`;
      }
      return text;
    })
    .join(',');
}

async function appendCsvRows(filePath, headers, rows) {
  if (!rows || rows.length === 0) {
    return;
  }

  const body = rows.map((row) => serializeCsvRow(headers, row)).join('\n');
  await fs.appendFile(filePath, `${body}\n`, 'utf8');
}

function parseCsvLine(line) {
  const output = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === ',' && !inQuotes) {
      output.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  output.push(current);
  return output;
}

async function readCsv(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (lines.length <= 1) {
      return [];
    }

    const headers = parseCsvLine(lines[0]);
    return lines.slice(1).map((line) => {
      const values = parseCsvLine(line);
      return headers.reduce((acc, header, index) => {
        acc[header] = values[index] ?? '';
        return acc;
      }, {});
    });
  } catch {
    return [];
  }
}

module.exports = {
  ensureCsv,
  appendCsvRows,
  readCsv,
};
