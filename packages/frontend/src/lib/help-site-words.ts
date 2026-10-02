// The public help site's own words (the search box and results), in each language a
// site can be offered in. Articles are the customer's; these are Mocco's.

export interface HelpSiteWords {
  search: string;
  searchPlaceholder: string;
  noResults: string;
  resultsFor: (query: string) => string;
}

const ENGLISH: HelpSiteWords = {
  search: 'Search',
  searchPlaceholder: 'Search help',
  noResults: 'No articles match.',
  resultsFor: q => `Results for “${q}”`,
};

const WORDS: Record<string, HelpSiteWords> = {
  en: ENGLISH,
  ko: {
    search: '검색',
    searchPlaceholder: '도움말 검색',
    noResults: '맞는 문서가 없어요.',
    resultsFor: q => `“${q}” 검색 결과`,
  },
  ja: {
    search: '検索',
    searchPlaceholder: 'ヘルプを検索',
    noResults: '一致する記事はありません。',
    resultsFor: q => `「${q}」の検索結果`,
  },
  zh: {
    search: '搜索',
    searchPlaceholder: '搜索帮助',
    noResults: '没有匹配的文章。',
    resultsFor: q => `“${q}”的搜索结果`,
  },
  th: {
    search: 'ค้นหา',
    searchPlaceholder: 'ค้นหาความช่วยเหลือ',
    noResults: 'ไม่พบบทความที่ตรงกัน',
    resultsFor: q => `ผลการค้นหา “${q}”`,
  },
  vi: {
    search: 'Tìm kiếm',
    searchPlaceholder: 'Tìm trợ giúp',
    noResults: 'Không có bài viết phù hợp.',
    resultsFor: q => `Kết quả cho “${q}”`,
  },
  id: {
    search: 'Cari',
    searchPlaceholder: 'Cari bantuan',
    noResults: 'Tidak ada artikel yang cocok.',
    resultsFor: q => `Hasil untuk “${q}”`,
  },
  es: {
    search: 'Buscar',
    searchPlaceholder: 'Buscar en la ayuda',
    noResults: 'Ningún artículo coincide.',
    resultsFor: q => `Resultados de «${q}»`,
  },
  pt: {
    search: 'Pesquisar',
    searchPlaceholder: 'Pesquisar na ajuda',
    noResults: 'Nenhum artigo corresponde.',
    resultsFor: q => `Resultados para “${q}”`,
  },
  fr: {
    search: 'Rechercher',
    searchPlaceholder: "Rechercher dans l'aide",
    noResults: 'Aucun article ne correspond.',
    resultsFor: q => `Résultats pour « ${q} »`,
  },
  de: {
    search: 'Suchen',
    searchPlaceholder: 'Hilfe durchsuchen',
    noResults: 'Keine passenden Artikel.',
    resultsFor: q => `Ergebnisse für „${q}“`,
  },
  it: {
    search: 'Cerca',
    searchPlaceholder: 'Cerca nella guida',
    noResults: 'Nessun articolo corrisponde.',
    resultsFor: q => `Risultati per «${q}»`,
  },
};

export const wordsFor = (locale: string): HelpSiteWords => WORDS[locale] ?? ENGLISH;
