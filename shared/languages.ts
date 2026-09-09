// The gateway declares the first three languages. The remaining eight have
// been verified through automatic detection; they are not explicit API options.
export const LANGUAGES = [
  { code: 'Chinese', locale: 'zh', label: '普通话', declared: true },
  { code: 'Cantonese', locale: 'yue', label: '粤语', declared: true },
  { code: 'English', locale: 'en', label: '英语', declared: true },
  { code: 'Japanese', locale: 'ja', label: '日语', declared: false },
  { code: 'German', locale: 'de', label: '德语', declared: false },
  { code: 'French', locale: 'fr', label: '法语', declared: false },
  { code: 'Spanish', locale: 'es', label: '西班牙语', declared: false },
  { code: 'Portuguese', locale: 'pt', label: '葡萄牙语', declared: false },
  { code: 'Korean', locale: 'ko', label: '韩语', declared: false },
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

export function languageLabel(value: string, emptyLabel = '语种待定') {
  return findLanguage(value)?.label || value.trim() || emptyLabel;
}
