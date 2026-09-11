import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import zh from './locales/zh';
import en from './locales/en';

/** 受支持的界面语言（顺序即设置页展示顺序） */
export const SUPPORTED_LANGUAGES = ['zh', 'en'] as const;
export type AppLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** 兜底语言：浏览器语言不受支持时使用中文 */
export const DEFAULT_LANGUAGE: AppLanguage = 'zh';

/** 语言偏好的 localStorage 键（由 i18next-browser-languagedetector 读写） */
export const LANGUAGE_STORAGE_KEY = 'papermind.language';

/** 语言自名：用各语言自身书写，因此不随界面语言翻译，设置页直接取用 */
export const LANGUAGE_LABELS: Record<AppLanguage, string> = {
  zh: '中文',
  en: 'English',
};

const resources = { zh, en };

/** 把任意语言标识归一化到受支持语言（'zh-CN' / 'en-US' → 'zh' / 'en'） */
export function normalizeLanguage(lng: string | null | undefined): AppLanguage {
  const base = (lng ?? '').toLowerCase().split('-')[0];
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(base) ? (base as AppLanguage) : DEFAULT_LANGUAGE;
}

/** 切换界面语言；i18next 的 detector 缓存负责把选择写入 localStorage（跨重启保留） */
export async function changeLanguage(lng: string): Promise<void> {
  await i18n.changeLanguage(normalizeLanguage(lng));
}

/** 同步 <html lang>，让浏览器/读屏软件拿到正确语言 */
function syncHtmlLang(lng: string): void {
  document.documentElement.lang = normalizeLanguage(lng) === 'zh' ? 'zh-CN' : 'en';
}

const ready = i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    supportedLngs: SUPPORTED_LANGUAGES,
    fallbackLng: DEFAULT_LANGUAGE,
    // 'zh-CN' 这类带地区的标识先按语言主干匹配，避免回落到兜底语言
    load: 'languageOnly',
    nonExplicitSupportedLngs: true,
    ns: Object.keys(zh),
    defaultNS: 'common',
    interpolation: { escapeValue: false },
    // 资源随包内置，无异步加载，关闭 Suspense 以免首屏被挂起
    react: { useSuspense: false },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
      caches: ['localStorage'],
    },
  });

i18n.on('languageChanged', syncHtmlLang);
void ready.then(() => syncHtmlLang(i18n.language));

export default i18n;
