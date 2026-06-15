// Validate that a jar is a Fabric mod and extract its metadata from fabric.mod.json.

import { readZipText } from './zip.js';

/**
 * Lenient JSON parse: strict first, then tolerate /* *\/ block comments and
 * trailing commas (some real-world fabric.mod.json files include them).
 *
 * We deliberately do NOT strip `//` line comments: a regex can't tell a real
 * comment from `//` inside a string value (paths, regexes, etc.) and would
 * silently truncate it. Block comments + trailing commas cover the common cases.
 */
function parseLenientJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    /* fall through */
  }
  const stripped = text
    // block comments
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // trailing commas before } or ]
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(stripped);
}

function normalizeMcDepend(depends) {
  if (!depends || typeof depends !== 'object') return null;
  const mc = depends.minecraft;
  if (mc === undefined || mc === null) return null;
  if (Array.isArray(mc)) return mc.map(String).join(', ');
  return String(mc);
}

/**
 * @param {Buffer} jarBuffer
 * @returns {{ id, version, mcDepend, hasPlaceholder, raw }}
 * @throws Error with a clear message if it's not a usable Fabric mod jar.
 */
export function parseFabricMod(jarBuffer) {
  let text;
  try {
    text = readZipText(jarBuffer, 'fabric.mod.json');
  } catch (e) {
    throw new Error(`Could not read the jar as a zip archive: ${e.message}`);
  }
  if (text === null) {
    throw new Error(
      'This jar does not contain a fabric.mod.json at its root — it is not a Fabric mod ' +
        '(or it is a Forge/NeoForge/dev jar).'
    );
  }

  let meta;
  try {
    meta = parseLenientJson(text);
  } catch (e) {
    throw new Error(`fabric.mod.json is present but not valid JSON: ${e.message}`);
  }

  const id = meta && typeof meta.id === 'string' ? meta.id.trim() : '';
  const version = meta && meta.version !== undefined ? String(meta.version).trim() : '';

  if (!id) {
    throw new Error('fabric.mod.json is missing a string "id" field.');
  }
  if (!version) {
    throw new Error('fabric.mod.json is missing a "version" field.');
  }

  const hasPlaceholder = /\$\{.*\}/.test(id) || /\$\{.*\}/.test(version);
  const mcDepend = normalizeMcDepend(meta.depends);

  return { id, version, mcDepend, hasPlaceholder, raw: meta };
}

/**
 * Compare a mod's declared Minecraft dependency against the expected version.
 * Returns a human-readable warning string, or null if it looks fine.
 */
export function mcVersionWarning(mcDepend, expected) {
  if (!mcDepend) {
    return `Mod does not declare a "depends.minecraft" — cannot confirm it targets Minecraft ${expected}.`;
  }
  // Soft check: if the expected version string does not appear in the declared
  // range/value, warn. This intentionally errs toward warning rather than blocking.
  if (mcDepend.includes(expected)) return null;
  // Also accept a major.minor prefix match (e.g. "1.21.x", ">=1.21").
  const mm = expected.split('.').slice(0, 2).join('.'); // "1.21"
  if (mm && mcDepend.includes(mm)) return null;
  return `Mod targets Minecraft "${mcDepend}", but this modpack expects ${expected}. Double-check compatibility.`;
}
