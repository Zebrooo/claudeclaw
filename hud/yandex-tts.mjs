/**
 * Yandex SpeechKit (TTS) — server-side synthesis proxy.
 *
 * The API key lives only on the server (.env), never in the browser. The HUD
 * frontend fetches /api/tts, which calls this and streams back OggOpus audio.
 *
 * REST v1 synthesize: POST https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize
 * Auth: `Authorization: Api-Key <key>` (service account key with the
 * ai.speechkit-tts.user role). Docs: https://yandex.cloud/docs/speechkit/tts/
 */
import https from 'node:https';

// v1 Russian voices. Those that support emotions are mapped so we never send an
// unsupported `emotion` (which would 400). Others synthesize without emotion.
export const SPEAKKIT_VOICES = [
  'alena',
  'filipp',
  'jane',
  'omazh',
  'ermil',
  'zahar',
  'oksana',
];
const EMOTIONS = {
  alena: ['neutral', 'good'],
  jane: ['neutral', 'good', 'evil'],
  omazh: ['neutral', 'evil'],
  zahar: ['neutral', 'good'],
  ermil: ['neutral', 'good'],
};

/**
 * @param {string} text
 * @param {{apiKey:string, voice?:string, emotion?:string, speed?:number, folderId?:string}} opts
 * @returns {Promise<Buffer>} OggOpus audio
 */
export function synthesize(text, opts) {
  return new Promise((resolve, reject) => {
    if (!opts.apiKey) return reject(new Error('no api key'));
    const voice = SPEAKKIT_VOICES.includes(opts.voice) ? opts.voice : 'alena';
    const params = new URLSearchParams({
      text: text.slice(0, 4500), // v1 limit ~5000 chars
      lang: 'ru-RU',
      voice,
      format: 'oggopus',
    });
    // Only attach emotion if this voice actually supports the requested one.
    const wanted = opts.emotion;
    if (wanted && EMOTIONS[voice] && EMOTIONS[voice].includes(wanted)) {
      params.set('emotion', wanted);
    }
    if (opts.speed) params.set('speed', String(opts.speed));
    if (opts.folderId) params.set('folderId', opts.folderId);

    const body = params.toString();
    const req = https.request(
      {
        method: 'POST',
        hostname: 'tts.api.cloud.yandex.net',
        path: '/speech/v1/tts:synthesize',
        headers: {
          Authorization: 'Api-Key ' + opts.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 15000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode === 200) resolve(buf);
          else reject(new Error(`yandex tts ${res.statusCode}: ${buf.toString('utf8').slice(0, 200)}`));
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('yandex tts timeout')));
    req.write(body);
    req.end();
  });
}
