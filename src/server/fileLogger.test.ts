import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  LOG_FILE_NAMES,
  SvlFileLogger,
  formatTxtLogLine,
  normalizeGuiLogBatch,
  scrubSensitiveText,
} from './fileLogger.ts';

describe('SvlFileLogger (katalog logi/*.txt)', () => {
  it('tworzy katalog logi oraz wszystkie pliki .txt na starcie i zapisuje wpisy w czasie rzeczywistym', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'svl-logi-test-'));
    try {
      const logger = new SvlFileLogger({ logDir: tmpDir });

      for (const fileName of Object.values(LOG_FILE_NAMES)) {
        const stat = await fs.stat(path.join(tmpDir, fileName));
        assert.equal(stat.isFile(), true);
      }

      logger.log({
        layer: 'GATEWAY',
        level: 'INFO',
        category: 'http_request',
        correlationId: 'req-123',
        origin: 'test-suite',
        message: 'GET /api/health -> 200 (2 ms)',
        details: { status: 200, operatorToken: 'SUPER_SECRET_SHOULD_HIDE_999999999999' },
      });

      logger.logBatch(
        normalizeGuiLogBatch({
          events: [
            {
              kind: 'navigation',
              level: 'INFO',
              action: 'Zmiana zakładki na Terminale (4)',
              tab: 'terminals',
              target: 'button[Terminale (4)]',
              origin: 'tab-test-1',
            },
            {
              kind: 'console_error',
              level: 'ERROR',
              action: 'Uncaught TypeError: demo failure',
              tab: 'chat',
              detail: { line: 42 },
            },
          ],
        }),
      );

      await logger.flush();

      const masterContent = await fs.readFile(path.join(tmpDir, LOG_FILE_NAMES.master), 'utf8');
      const gatewayContent = await fs.readFile(path.join(tmpDir, LOG_FILE_NAMES.gateway), 'utf8');
      const guiContent = await fs.readFile(path.join(tmpDir, LOG_FILE_NAMES.gui), 'utf8');

      assert.match(gatewayContent, /\[GATEWAY\] \[INFO\] \[http_request\] \[corr=req-123\] \[origin=test-suite\] GET \/api\/health -> 200/);
      assert.doesNotMatch(gatewayContent, /SUPER_SECRET_SHOULD_HIDE/);
      assert.match(gatewayContent, /"operatorToken":"\[REDACTED\]"/);

      assert.match(guiContent, /\[GUI\] \[INFO\] \[navigation\] .*Zmiana zakładki na Terminale/);
      assert.match(guiContent, /\[GUI\] \[ERROR\] \[console_error\] .*Uncaught TypeError: demo failure/);

      // Plik zbiorczy zawiera zarówno zdarzenia backendu Gateway, jak i GUI
      assert.match(masterContent, /GET \/api\/health -> 200/);
      assert.match(masterContent, /Zmiana zakładki na Terminale/);
      assert.match(masterContent, /Uncaught TypeError: demo failure/);

      const summary = await logger.getSummary();
      assert.equal(summary.logDir, tmpDir);
      assert.equal(summary.files.length, 4);
      assert.ok((summary.files.find((f) => f.name === LOG_FILE_NAMES.master)?.lines || 0) >= 4);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('czyści tokeny Bearer, klucze API, klucze SSH i obrazy base64 z logów tekstowych', () => {
    const fakeSecret = 'AbCdEf1234567890GhIjKlMnOpQrStUvWxYz';
    const raw = `Auth: Bearer ${fakeSecret} svl-auth.ZmFrZXRva2Vu data:image/png;base64,${'A'.repeat(64)} -----BEGIN OPENSSH PRIVATE KEY-----xyz-----END OPENSSH PRIVATE KEY-----`;
    const scrubbed = scrubSensitiveText(raw, [fakeSecret]);
    assert.doesNotMatch(scrubbed, new RegExp(fakeSecret));
    assert.doesNotMatch(scrubbed, /ZmFrZXRva2Vu/);
    assert.doesNotMatch(scrubbed, /OPENSSH PRIVATE KEY/);
    assert.match(scrubbed, /Bearer \[REDACTED\]/);
    assert.match(scrubbed, /svl-auth\.\[REDACTED\]/);
    assert.match(scrubbed, /\[DATA_IMAGE_BASE64\]/);
    assert.match(scrubbed, /\[REDACTED_PRIVATE_KEY\]/);

    const line = formatTxtLogLine({
      layer: 'WS',
      level: 'WARN',
      category: 'ws_auth',
      message: `Odrzucono połączenie z token=${fakeSecret}`,
    });
    assert.ok(line.endsWith('\n'));
    assert.doesNotMatch(line, new RegExp(fakeSecret));
  });
});
