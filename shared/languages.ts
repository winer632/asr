// The gateway declares the first six languages for explicit selection
// (SenseNova ASR 2609). The remaining six have been verified through automatic
// detection only; they are not options the service documents.
export const LANGUAGES = [
  { code: 'Chinese', locale: 'zh', label: '普通话', declared: true },
  { code: 'Cantonese', locale: 'yue', label: '粤语', declared: true },
  { code: 'English', locale: 'en', label: '英语', declared: true },
  { code: 'Japanese', locale: 'ja', label: '日语', declared: true },
  { code: 'Korean', locale: 'ko', label: '韩语', declared: true },
  { code: 'Arabic', locale: 'ar', label: '阿拉伯语', declared: true },
  { code: 'German', locale: 'de', label: '德语', declared: false },
  { code: 'French', locale: 'fr', label: '法语', declared: false },
  { code: 'Spanish', locale: 'es', label: '西班牙语', declared: false },
  { code: 'Portuguese', locale: 'pt', label: '葡萄牙语', declared: false },
  { code: 'Thai', locale: 'th', label: '泰语', declared: false },
  { code: 'Vietnamese', locale: 'vi', label: '越南语', declared: false },
] as const;

export type Language = (typeof LANGUAGES)[number]['code'];

export function findLanguage(value: string) {
  const normalized = value.trim().toLowerCase();
  return LANGUAGES.find(
    (language) =>
      language.code.toLowerCase() === normalized ||
      language.locale === normalized ||
      language.label === normalized,
  );
}

// Only the declared six can be named explicitly; the service answers
// invalid_language for anything else, so a browser's choice is checked here
// before it reaches the upstream.
export const SELECTABLE = LANGUAGES.filter((language) => language.declared);

export function declaredLanguage(value: string) {
  const language = findLanguage(value);
  return language?.declared ? language : undefined;
}

export function languageLabel(value: string, emptyLabel = '语种待定') {
  return findLanguage(value)?.label || value.trim() || emptyLabel;
}
