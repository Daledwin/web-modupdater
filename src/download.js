// Download a URL into a Buffer, following redirects. Built-in modules only.

import http from 'node:http';
import https from 'node:https';
import { lastUrlSegment } from './util.js';

const MAX_REDIRECTS = 8;

function filenameFromContentDisposition(header) {
  if (!header) return null;
  // filename*=UTF-8''name.jar  (RFC 5987) takes precedence
  let m = header.match(/filename\*\s*=\s*[^']*''([^;]+)/i);
  if (m) {
    try {
      return decodeURIComponent(m[1].trim().replace(/^["']|["']$/g, ''));
    } catch {
      /* ignore */
    }
  }
  m = header.match(/filename\s*=\s*("?)([^";]+)\1/i);
  if (m) return m[2].trim();
  return null;
}

/**
 * @param {string} url
 * @param {{ maxBytes?: number, onProgress?: (loaded:number,total:number|null)=>void }} opts
 * @returns {Promise<{ buffer: Buffer, finalUrl: string, suggestedName: string }>}
 */
export function downloadToBuffer(url, opts = {}) {
  const { maxBytes = 256 * 1024 * 1024, onProgress } = opts;
  return new Promise((resolve, reject) => {
    const visit = (current, redirectsLeft, headerName) => {
      let parsed;
      try {
        parsed = new URL(current);
      } catch {
        return reject(new Error(`Invalid URL: ${current}`));
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return reject(new Error(`Unsupported URL protocol: ${parsed.protocol}`));
      }
      const lib = parsed.protocol === 'https:' ? https : http;

      const req = lib.get(
        parsed,
        {
          headers: {
            'User-Agent': 'web-modupdater/1.0 (+local)',
            Accept: 'application/java-archive, application/octet-stream, */*',
          },
        },
        (res) => {
          const status = res.statusCode || 0;

          // Redirect handling
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume(); // discard body
            if (redirectsLeft <= 0) {
              return reject(new Error('Too many redirects while downloading the jar.'));
            }
            const next = new URL(res.headers.location, parsed).toString();
            return visit(next, redirectsLeft - 1, headerName);
          }

          if (status !== 200) {
            res.resume();
            return reject(
              new Error(`Download failed: HTTP ${status} for ${parsed.toString()}`)
            );
          }

          const total = res.headers['content-length']
            ? Number(res.headers['content-length'])
            : null;
          const dispName = filenameFromContentDisposition(
            res.headers['content-disposition']
          );

          const chunks = [];
          let loaded = 0;
          res.on('data', (chunk) => {
            loaded += chunk.length;
            if (loaded > maxBytes) {
              req.destroy();
              return reject(
                new Error(
                  `Download exceeds the maximum allowed size (${maxBytes} bytes).`
                )
              );
            }
            chunks.push(chunk);
            if (onProgress) onProgress(loaded, total);
          });
          res.on('end', () => {
            const buffer = Buffer.concat(chunks);
            const suggestedName =
              dispName || headerName || lastUrlSegment(parsed.toString()) || 'mod.jar';
            resolve({ buffer, finalUrl: parsed.toString(), suggestedName });
          });
          res.on('error', reject);
        }
      );
      req.on('error', reject);
      req.setTimeout(120000, () => {
        req.destroy(new Error('Download timed out.'));
      });
    };

    visit(url, MAX_REDIRECTS, lastUrlSegment(url));
  });
}
