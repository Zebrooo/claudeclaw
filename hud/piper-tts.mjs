/**
 * Piper TTS — local neural text-to-speech.
 *
 * Fully offline: no API key, no cloud. The HUD server shells out to the piper
 * binary, which synthesizes a WAV from a downloaded voice model (.onnx). Used
 * as the /api/tts backend when Yandex SpeechKit isn't configured.
 *
 * Binary + voices are installed under ~/piper (see .env: PIPER_BIN,
 * PIPER_VOICES_DIR, PIPER_LIB_DIR). Voice models from rhasspy/piper-voices.
 */
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** List installed voice ids (filename without .onnx), e.g. "ru_RU-irina-medium". */
export function listPiperVoices(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.onnx'))
    .map((f) => f.replace(/\.onnx$/, ''))
    .sort();
}

/**
 * @param {string} text
 * @param {{bin:string, voicesDir:string, voice:string, libDir?:string}} opts
 * @returns {Promise<Buffer>} 16-bit PCM WAV (22050 Hz mono)
 */
export function synthesizePiper(text, opts) {
  return new Promise((resolve, reject) => {
    const model = path.join(opts.voicesDir, opts.voice + '.onnx');
    if (!existsSync(opts.bin)) return reject(new Error('piper binary missing'));
    if (!existsSync(model)) return reject(new Error('voice not found: ' + opts.voice));

    const tmp = mkdtempSync(path.join(os.tmpdir(), 'piper-'));
    const out = path.join(tmp, 'o.wav');
    const cleanup = () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } };
    // piper needs its bundled .so libs on the loader path.
    const libDir = opts.libDir || path.dirname(opts.bin);
    const env = {
      ...process.env,
      LD_LIBRARY_PATH: libDir + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : ''),
    };

    const p = spawn(opts.bin, ['--model', model, '--output_file', out], { env });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => { cleanup(); reject(e); });
    p.on('close', (code) => {
      try {
        if (code === 0 && existsSync(out)) {
          const buf = readFileSync(out);
          cleanup();
          resolve(buf);
        } else {
          cleanup();
          reject(new Error(`piper exit ${code}: ${err.slice(0, 200)}`));
        }
      } catch (e) {
        cleanup();
        reject(e);
      }
    });
    p.stdin.write(text.slice(0, 4500));
    p.stdin.end();
  });
}
