// Two interface languages: Chinese and English. The choice is remembered per
// browser; the first visit follows the browser's language. Strings are written
// inline as t('中文', 'English') so each one stays readable where it is used.

export type Lang = 'zh' | 'en'

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem('atrium.lang')
    if (saved === 'zh' || saved === 'en') return saved
  } catch {
    /* storage unavailable */
  }
  return (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export const lang: Lang = initialLang()
document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'

export const t = (zh: string, en: string) => (lang === 'zh' ? zh : en)

/** Switching re-renders everything from scratch, which is simplest and rare. */
export function setLang(l: Lang) {
  try {
    localStorage.setItem('atrium.lang', l)
  } catch {
    /* ignore */
  }
  location.reload()
}
