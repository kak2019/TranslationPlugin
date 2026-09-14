const WORDBOOK_MAX_ENTRIES = 5000;
const WORDBOOK_MAX_CHARS = 40;
const WORDBOOK_MAX_WORDS = 4;
const WORDBOOK_WORD_RE = /^[A-Za-z]+(?:[-'][A-Za-z]+)*$/;
const WORDBOOK_SENTENCE_PUNCT_RE = /[.?!;:。！？…]/;
const WORDBOOK_DEFAULT_OBJECT_KEY = 'arya-translate/wordbook.json';

function normalizeWordbookText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function normalizeEnKey(text) {
  return normalizeWordbookText(text).toLowerCase();
}

function isLatinDominant(text) {
  const t = String(text || '');
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  const cjk = (t.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  return letters >= 2 && letters > cjk * 2;
}

function tokenizeEnglishWords(text) {
  return normalizeWordbookText(text).split(' ').filter(Boolean);
}

function isSingleEnglishWord(text) {
  const t = normalizeWordbookText(text);
  return Boolean(t) && t.length <= WORDBOOK_MAX_CHARS && WORDBOOK_WORD_RE.test(t);
}

function isVocabCandidate(text) {
  const t = normalizeWordbookText(text);
  if (!t || t.length > WORDBOOK_MAX_CHARS) return false;
  if (WORDBOOK_SENTENCE_PUNCT_RE.test(t)) return false;
  if (/https?:\/\//i.test(t) || /^\d+$/.test(t)) return false;
  if (!isLatinDominant(t)) return false;
  const words = tokenizeEnglishWords(t);
  if (words.length < 1 || words.length > WORDBOOK_MAX_WORDS) return false;
  return words.every((word) => WORDBOOK_WORD_RE.test(word));
}

function meetsSelectionThreshold(text, minLen) {
  const t = normalizeWordbookText(text);
  if (!t) return false;
  if (isSingleEnglishWord(t)) return t.length >= 1;
  return t.length >= Math.max(1, Number(minLen) || 4);
}

function isChineseTarget(targetLang) {
  return /中文|Chinese/i.test(String(targetLang || ''));
}

function hasChinese(text) {
  return /[\u4e00-\u9fff]/.test(String(text || ''));
}

function pickZh(translation, sourceEn = '') {
  const t = normalizeWordbookText(translation);
  if (!t || !hasChinese(t)) return '';
  if (normalizeEnKey(t) === normalizeEnKey(sourceEn)) return '';
  return t;
}

function createWordbookId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeWordbookEntry(raw, fallbackNow = Date.now()) {
  const en = normalizeWordbookText(raw?.en);
  if (!en) return null;
  const addedAt = Number(raw?.addedAt) || fallbackNow;
  const updatedAt = Number(raw?.updatedAt) || addedAt;
  return {
    id: String(raw?.id || createWordbookId()),
    en,
    zh: normalizeWordbookText(raw?.zh),
    addedAt,
    updatedAt,
    sourceUrl: String(raw?.sourceUrl || '').slice(0, 500)
  };
}

function normalizeWordbookEntries(raw) {
  if (!Array.isArray(raw)) return [];
  const map = new Map();
  for (const item of raw) {
    const entry = normalizeWordbookEntry(item);
    if (!entry) continue;
    const key = normalizeEnKey(entry.en);
    const prev = map.get(key);
    if (!prev || entry.updatedAt >= prev.updatedAt) map.set(key, entry);
  }
  return [...map.values()]
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, WORDBOOK_MAX_ENTRIES);
}

function upsertWordbookEntry(entries, incoming) {
  const list = Array.isArray(entries) ? [...entries] : [];
  const en = normalizeWordbookText(incoming?.en);
  if (!en) return { entries: list, entry: null, added: false, updated: false };
  const key = normalizeEnKey(en);
  const now = Date.now();
  const idx = list.findIndex((item) => normalizeEnKey(item.en) === key);
  if (idx >= 0) {
    const prev = list[idx];
    const entry = {
      ...prev,
      en,
      zh: normalizeWordbookText(incoming?.zh) || prev.zh,
      updatedAt: now,
      sourceUrl: String(incoming?.sourceUrl || prev.sourceUrl || '').slice(0, 500)
    };
    list.splice(idx, 1);
    list.unshift(entry);
    return { entries: list, entry, added: false, updated: true };
  }
  const entry = normalizeWordbookEntry({
    en,
    zh: incoming?.zh,
    sourceUrl: incoming?.sourceUrl,
    addedAt: now,
    updatedAt: now
  }, now);
  list.unshift(entry);
  return {
    entries: list.slice(0, WORDBOOK_MAX_ENTRIES),
    entry,
    added: true,
    updated: false
  };
}

function mergeWordbookEntries(localEntries, remoteEntries) {
  return normalizeWordbookEntries([...(localEntries || []), ...(remoteEntries || [])]);
}

function normalizeOssRegion(region) {
  let value = String(region || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .split('.')[0];
  if (!value) return '';
  if (!value.startsWith('oss-')) value = `oss-${value}`;
  return value;
}

function normalizeOssObjectKey(objectKey) {
  const value = String(objectKey || WORDBOOK_DEFAULT_OBJECT_KEY).trim().replace(/^\/+/, '');
  return value || WORDBOOK_DEFAULT_OBJECT_KEY;
}

const AryaWordbook = {
  WORDBOOK_MAX_ENTRIES,
  WORDBOOK_DEFAULT_OBJECT_KEY,
  normalizeWordbookText,
  normalizeEnKey,
  isSingleEnglishWord,
  isVocabCandidate,
  meetsSelectionThreshold,
  isChineseTarget,
  hasChinese,
  pickZh,
  createWordbookId,
  normalizeWordbookEntry,
  normalizeWordbookEntries,
  upsertWordbookEntry,
  mergeWordbookEntries,
  normalizeOssRegion,
  normalizeOssObjectKey
};

if (typeof module !== 'undefined') {
  module.exports = AryaWordbook;
}
if (typeof self !== 'undefined') {
  self.AryaWordbook = AryaWordbook;
}
